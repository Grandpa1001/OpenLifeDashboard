// D02.1 — the built server and SPA over real HTTP (Architektura §6.1).
// AC1: health JSON and the SPA document on reload of UI routes; AC2: API 404 JSON with
// NOT_FOUND/requestId and plain 404 for missing assets, never the SPA; AC3: only health is
// exposed and SIGTERM stops the process. Responses are saved as verify:task evidence.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema, REQUEST_ID_HEADER } from "@openlife/contracts/http/errors";
import { HEALTH_PATH, healthResponseSchema } from "@openlife/contracts/http/health";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_DIR_ENV } from "../../../tooling/verification-tasks.ts";
import { runServerEntry, SERVER_ENTRY, startBuiltServer, waitForExit, WEB_INDEX, type ServerProcess } from "../../support/server-process.ts";

const SHUTDOWN_LIMIT_MS = 15_000;
const UI_ROUTES = ["/", "/main", "/registers/ksiazki"];
// Endpoints that later tasks protect; until they exist nothing may answer them with data.
// Sign-in, sign-out and the identity status exist since D09.3, the setup status since D11.4;
// they have their own tests.
const FUTURE_PRIVATE_ENDPOINTS = [
  ["POST", "/api/auth/sign-up/email"],
  ["GET", "/api/v1/registries"],
  ["GET", "/api/v1/export"],
  ["GET", "/api/v1/stream"],
] as const;

type Evidence = { method: string; path: string; status: number; contentType: string | null; cacheControl: string | null; body: string };
const evidence: Evidence[] = [];
let server: ServerProcess;
let indexHtml: string;

async function request(method: string, requestPath: string, init: RequestInit = {}): Promise<{ response: Response; body: string }> {
  const response = await fetch(`${server.baseUrl}${requestPath}`, { ...init, method, redirect: "manual" });
  const body = await response.text();
  evidence.push({
    method,
    path: requestPath,
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    body: body.length > 2_000 ? `${body.slice(0, 2_000)}… (${body.length} chars)` : body,
  });
  return { response, body };
}

beforeAll(async () => {
  for (const artifact of [SERVER_ENTRY, WEB_INDEX]) {
    try {
      readFileSync(artifact);
    } catch {
      throw new Error(`${path.relative(process.cwd(), artifact)} is missing; run "pnpm build" first`);
    }
  }
  indexHtml = readFileSync(WEB_INDEX, "utf8");
  server = await startBuiltServer();
});

afterAll(async () => {
  if (server && server.child.exitCode === null) {
    server.child.kill("SIGTERM");
    await waitForExit(server.child, server.output, SHUTDOWN_LIMIT_MS);
  }
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, "http-responses.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

describe("D02.1-AC1 health and SPA document", () => {
  it("GET /api/health returns 200 JSON {status: ok} without caching", async () => {
    const { response, body } = await request("GET", HEALTH_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(healthResponseSchema.parse(JSON.parse(body))).toEqual({ status: "ok" });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });

  it.each(UI_ROUTES)("reloading %s returns the built index.html", async (route) => {
    const { response, body } = await request("GET", route);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/i);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(body).toBe(indexHtml);
  });

  it("HEAD on a UI route answers like GET without a body", async () => {
    const { response, body } = await request("HEAD", "/main");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/i);
    expect(body).toBe("");
  });

  it("serves hashed assets referenced by index.html with immutable caching", async () => {
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(indexHtml)?.[1];
    expect(asset).toBeDefined();
    const { response } = await request("GET", asset ?? "/missing");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });
});

describe("D02.1-AC2 unknown API and missing assets never return the SPA", () => {
  it.each([
    ["GET", "/api"],
    ["GET", "/api/unknown"],
    ["GET", "/api/v1/registries/ksiazki/records"],
    ["POST", HEALTH_PATH],
    ["DELETE", HEALTH_PATH],
  ])("%s %s → 404 JSON NOT_FOUND with the response requestId", async (method, route) => {
    const { response, body } = await request(method, route);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    const error = apiErrorSchema.parse(JSON.parse(body));
    expect(error.code).toBe("NOT_FOUND");
    expect(error.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
    expect(body).not.toContain("<!doctype");
  });

  it.each(["/assets/missing.js", "/favicon.ico", "/robots.txt", "/..%2f..%2fpackage.json", "/%2e%2e/package.json"])(
    "GET %s → 404 without the SPA document or files outside the web root",
    async (route) => {
      const { response, body } = await request("GET", route);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type") ?? "").not.toMatch(/html/i);
      expect(body).not.toContain("<!doctype");
      expect(body).not.toContain('"name"');
    },
  );

  it("a non-GET request to a UI path is not answered with the SPA", async () => {
    const { response, body } = await request("POST", "/main");
    expect(response.status).toBe(404);
    expect(body).not.toContain("<!doctype");
  });

  it("the request ID is generated by the server, not taken from the client", async () => {
    const { response } = await request("GET", HEALTH_PATH, { headers: { [REQUEST_ID_HEADER]: "client-chosen" } });
    expect(response.headers.get(REQUEST_ID_HEADER)).not.toBe("client-chosen");
  });
});

describe("D02.1-AC3 no unprotected data and clean shutdown", () => {
  it.each(FUTURE_PRIVATE_ENDPOINTS)("%s %s is not exposed (404 JSON)", async (method, route) => {
    const { response, body } = await request(method, route);
    expect(response.status).toBe(404);
    expect(apiErrorSchema.parse(JSON.parse(body)).code).toBe("NOT_FOUND");
  });

  it("SIGTERM stops a running server with exit code 0 and closes the port", async () => {
    const stopping = await startBuiltServer();
    const healthy = await fetch(`${stopping.baseUrl}${HEALTH_PATH}`);
    expect(healthy.status).toBe(200);
    stopping.child.kill("SIGTERM");
    const exit = await waitForExit(stopping.child, stopping.output, SHUTDOWN_LIMIT_MS);
    expect(exit.code).toBe(0);
    expect(exit.output).toContain('"event":"server.stopped"');
    await expect(fetch(`${stopping.baseUrl}${HEALTH_PATH}`)).rejects.toThrow();
  });

  it("refuses to start without a built web app, with a readable stderr message", async () => {
    const exit = await runServerEntry(["--port", "0", "--web-root", path.join(process.cwd(), "does-not-exist")]);
    expect(exit.code).toBe(1);
    expect(exit.output).toContain("web app not found");
  });
});
