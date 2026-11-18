// D60.1 — the security headers of every response of the built server (DEV §9.59, Architektura §9.4, §12.1).
// AC1: the document, a hashed asset, the API, an unknown route and an error answer have the headers of the table, in the
// local mode and as they are, and none of them carries Strict-Transport-Security (HTTP on localhost must not get it; Caddy
// sets it in the server mode). The behaviour of the policy in a browser is the e2e test of AC2.
import { readFileSync } from "node:fs";
import { HEALTH_PATH } from "@openlife/contracts/http/health";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBuiltServer, waitForExit, WEB_INDEX, type ServerProcess } from "../../support/server-process.ts";

let server: ServerProcess;
let asset: string;

beforeAll(async () => {
  asset = /src="(\/assets\/[^"]+\.js)"/.exec(readFileSync(WEB_INDEX, "utf8"))?.[1] ?? "";
  server = await startBuiltServer();
});
afterAll(async () => {
  if (server && server.child.exitCode === null) {
    server.child.kill("SIGTERM");
    await waitForExit(server.child, server.output, 15_000);
  }
});

const POLICY_PARTS = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self' data:", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"];

describe("D60.1-AC1 every response carries the security headers", () => {
  const cases: ReadonlyArray<readonly [string, string, string, number]> = [
    ["the SPA document", "GET", "/", 200],
    ["a UI route that is reloaded", "GET", "/registers/ksiazki", 200],
    ["a hashed asset", "GET", "{asset}", 200],
    ["the health of the API", "GET", HEALTH_PATH, 200],
    ["an unknown API route", "GET", "/api/v1/nothing-here", 404],
    ["a missing file", "GET", "/assets/missing.js", 404],
    ["a refused method", "DELETE", HEALTH_PATH, 404],
  ];
  for (const [name, method, route, status] of cases) {
    it(`${name} (${method} ${route})`, async () => {
      const response = await fetch(`${server.baseUrl}${route.replace("{asset}", asset)}`, { method, redirect: "manual" });
      await response.arrayBuffer();
      expect(response.status).toBe(status);
      const policy = response.headers.get("content-security-policy") ?? "";
      for (const part of POLICY_PARTS) expect(policy, part).toContain(part);
      expect(policy).not.toContain("unsafe-inline");
      expect(policy).not.toContain("unsafe-eval");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
      expect(response.headers.has("strict-transport-security")).toBe(false);
    });
  }

  it("an answer of an error handler (a body that is not JSON) has them too", async () => {
    const response = await fetch(`${server.baseUrl}/api/v1/registries`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json", redirect: "manual" });
    await response.arrayBuffer();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
