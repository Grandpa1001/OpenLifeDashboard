// D06.1 — requestId and the technical log over real HTTP (Architektura §15.2).
// AC1: the error response, the request line and the error line carry the same server-side
//      request ID, found in the log file, and a line holds only allowed fields.
// AC2: markers of a password, cookie, token, TOTP code and a ConfigTable value sent in headers,
//      query, path and body, and carried in a nested error, are absent from stdout, stderr and
//      the log file; the request is never serialized.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { apiErrorSchema, REQUEST_ID_HEADER } from "@openlife/contracts/http/errors";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { createRotatingFileSink } from "../../../apps/server/dist/adapters/logging/rotating-file-sink.js";
import { createTechnicalLogger } from "../../../apps/server/dist/adapters/logging/technical-logger.js";
import { installHttpFoundation } from "../../../apps/server/dist/http/foundation.js";
import type { AppEnv } from "../../../apps/server/dist/http/app-env.js";
import { startBuiltServer, waitForExit } from "../../support/server-process.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-request-log-"));
const servers: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const server of servers) server.close();
  rmSync(scratch, { recursive: true, force: true });
});

const unique = () => randomBytes(6).toString("hex");
/** Markers are random per run, so nothing in the repository can contain them by accident. */
const markers = {
  password: `PWD-${unique()}`,
  cookie: `COOKIE-${unique()}`,
  token: `TOKEN-${unique()}`,
  totp: `TOTP-${unique()}`,
  configTable: `CONFIG-${unique()}`,
  query: `QUERY-${unique()}`,
  pathParam: `PATH-${unique()}`,
};
const markerValues = Object.values(markers);
const hits = (text: string): string[] => markerValues.filter((marker) => text.includes(marker));

const ALLOWED_LINE_KEYS = new Set(["timestamp", "level", "service", "appVersion", "instanceId", "event", "requestId", "operationId", "durationMs", "code", "method", "route", "status", "error", "dropped"]);
const ALLOWED_ERROR_KEYS = new Set(["name", "code", "cause"]);

type Line = Record<string, unknown> & { event?: string; requestId?: string; status?: number };
const linesOf = (text: string): Line[] => text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Line);

function expectOnlyAllowedFields(line: Line): void {
  expect([...Object.keys(line)].filter((key) => !ALLOWED_LINE_KEYS.has(key))).toEqual([]);
  const error = line["error"];
  for (let described = error; typeof described === "object" && described !== null; described = (described as { cause?: unknown }).cause) {
    expect(Object.keys(described).filter((key) => !ALLOWED_ERROR_KEYS.has(key))).toEqual([]);
  }
}

/** The production foundation with extra routes, served on an ephemeral port with a real file sink. */
async function composedApp() {
  const logDir = mkdtempSync(path.join(scratch, "logs-"));
  const fileSink = createRotatingFileSink({
    dir: logDir,
    limits: () => ({ fileMaxBytes: 10 * 1024 * 1024, maxFiles: 5, retentionDays: 14 }),
    now: () => new Date(),
    notify: () => undefined,
  });
  const captured: string[] = [];
  const logger = createTechnicalLogger({
    identity: { service: "app", appVersion: "0.0.0", instanceId: randomUUID() },
    minLevel: "info",
    now: () => new Date(),
    sinks: [{ write: (line) => captured.push(line) }, fileSink],
  });
  const app = new Hono<AppEnv>();
  installHttpFoundation(app, { newRequestId: randomUUID, logger, nowMs: () => performance.now() });
  app.get("/boom", () => {
    const deepest = new RangeError(`totp ${markers.totp}`);
    const middle = new TypeError(`config ${markers.configTable} cookie ${markers.cookie}`, { cause: deepest });
    const error = new Error(`password=${markers.password}`, { cause: middle });
    error.stack = `Error: ${markers.password}\n    at ${markers.token}`;
    Object.assign(error, { token: markers.token, headers: { cookie: markers.cookie }, code: "SQLITE_CONSTRAINT_UNIQUE" });
    throw error;
  });
  app.get("/throw-string", () => {
    throw `session ${markers.cookie}`;
  });
  app.get("/throw-object", () => {
    throw { password: markers.password, totp: markers.totp };
  });
  app.post("/login/:user", async (c) => c.json({ received: (await c.req.text()).length, user: c.req.param("user").length }));
  const started = await new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => resolve({ port: address.port, close: () => server.close() }));
  });
  servers.push(started);
  return {
    base: `http://127.0.0.1:${started.port}`,
    captured,
    // The sink writes in a later turn of the event loop: flush before reading.
    file: () => {
      fileSink.flush();
      return readFileSync(fileSink.status().file, "utf8");
    },
  };
}

const secretHeaders = {
  cookie: `session=${markers.cookie}`,
  authorization: `Bearer ${markers.token}`,
  "x-api-key": markers.token,
  "content-type": "application/json",
};
const secretBody = JSON.stringify({ password: markers.password, totp: markers.totp, configValue: markers.configTable });

describe("D06.1-AC1 one request ID from the response to the log file", () => {
  it("a failing handler: response body, header, request line and error line share the ID", async () => {
    const app = await composedApp();
    const response = await fetch(`${app.base}/boom?q=${markers.query}`, { method: "GET", headers: secretHeaders });
    expect(response.status).toBe(500);
    const id = response.headers.get(REQUEST_ID_HEADER);
    const body = apiErrorSchema.parse(await response.json());
    expect(id).toBeTruthy();
    expect(body).toEqual({ code: "INTERNAL_ERROR", message: "Internal server error", details: null, requestId: id });

    const lines = linesOf(app.file()).filter((line) => line.requestId === id);
    expect(lines.map((line) => line.event).sort()).toEqual(["http.request", "http.unhandled_error"]);
    expect(lines.find((line) => line.event === "http.request")).toMatchObject({ method: "GET", route: "/boom", status: 500 });
    expect(lines.find((line) => line.event === "http.unhandled_error")).toMatchObject({
      level: "error",
      error: { name: "Error", code: "SQLITE_CONSTRAINT_UNIQUE", cause: { name: "TypeError", cause: { name: "RangeError" } } },
    });
    for (const line of linesOf(app.file())) expectOnlyAllowedFields(line);
    expect(app.captured.map((line) => JSON.parse(line).requestId)).toEqual(lines.map((line) => line.requestId).sort(() => 0));
  });

  it("an incoming X-Request-Id cannot choose the ID", async () => {
    const app = await composedApp();
    const chosen = `chosen-${unique()}`;
    const response = await fetch(`${app.base}/boom`, { headers: { [REQUEST_ID_HEADER]: chosen } });
    expect(response.headers.get(REQUEST_ID_HEADER)).not.toBe(chosen);
    expect(app.file()).not.toContain(chosen);
  });

  it("every request gets its own ID and its own line", async () => {
    const app = await composedApp();
    const ids = new Set<string>();
    for (let index = 0; index < 5; index += 1) ids.add((await fetch(`${app.base}/boom`)).headers.get(REQUEST_ID_HEADER) ?? "");
    expect(ids.size).toBe(5);
    expect(linesOf(app.file()).filter((line) => line.event === "http.request").map((line) => line.requestId).sort()).toEqual([...ids].sort());
  });
});

describe("D06.1-AC2 no secret reaches the log", () => {
  it("headers, query, path parameter, body and a nested error leave no marker in the log", async () => {
    const app = await composedApp();
    const responses = await Promise.all([
      fetch(`${app.base}/boom?q=${markers.query}`, { headers: secretHeaders }),
      fetch(`${app.base}/throw-string?q=${markers.query}`, { headers: secretHeaders }),
      fetch(`${app.base}/throw-object`, { headers: secretHeaders }),
      fetch(`${app.base}/login/${markers.pathParam}?q=${markers.query}`, { method: "POST", headers: secretHeaders, body: secretBody }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([500, 500, 500, 200]);
    // A thrown string or object leaves Hono's error handler: it still gets the JSON error and its ID.
    for (const response of responses.slice(0, 3)) {
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
    }
    const responseBodies = await Promise.all(responses.map((response) => response.text()));
    for (const [index, body] of responseBodies.slice(0, 3).entries()) {
      expect(apiErrorSchema.parse(JSON.parse(body)).requestId, `body ${index}`).toBe(responses[index]?.headers.get(REQUEST_ID_HEADER));
    }
    // The responses themselves are clean as well: the error body is the fixed fallback.
    expect(hits(responseBodies.join("\n"))).toEqual([]);

    const everything = `${app.captured.join("")}\n${app.file()}`;
    expect(hits(everything)).toEqual([]);
    for (const line of linesOf(everything)) expectOnlyAllowedFields(line);
    // The route is the template: the path parameter value does not appear, the template does.
    expect(linesOf(app.file()).find((line) => line["method"] === "POST")).toMatchObject({ route: "/login/:user", status: 200 });
    const errorLines = linesOf(app.file()).filter((line) => line.event === "http.unhandled_error");
    expect(errorLines).toHaveLength(3);
    expect(errorLines.map((line) => line["error"])).toEqual(
      expect.arrayContaining([{ name: "NonErrorThrown" }, { name: "NonErrorThrown" }]),
    );
    // Each of the three failed requests has its request line with status 500 under the same ID.
    for (const line of errorLines) {
      expect(linesOf(app.file()).find((other) => other.event === "http.request" && other.requestId === line.requestId)).toMatchObject({ status: 500 });
    }
  });
});

describe("D06.1 the built server", () => {
  it("a request full of secrets: the ID reaches app.jsonl, stdout and stderr hold no marker", async () => {
    const server = await startBuiltServer();
    const response = await fetch(`${server.baseUrl}/api/v1/unknown/${markers.pathParam}?q=${markers.query}`, { method: "POST", headers: secretHeaders, body: secretBody });
    expect(response.status).toBe(404);
    const id = response.headers.get(REQUEST_ID_HEADER);
    expect(apiErrorSchema.parse(await response.json()).requestId).toBe(id);
    await fetch(`${server.baseUrl}/api/health`);

    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child, server.output, 15_000);
    expect(exit.code).toBe(0);
    const file = readFileSync(path.join(server.installationDir, "data", "logs", "app", "app.jsonl"), "utf8");

    const requestLines = linesOf(file).filter((line) => line.event === "http.request");
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toMatchObject({ requestId: id, method: "POST", route: "/api/*", status: 404, service: "app", level: "info" });
    // The same line is on stdout; the health probe is debug level and in neither.
    expect(linesOf(exit.output).filter((line) => line.event === "http.request")).toEqual(requestLines);
    for (const line of linesOf(file)) expectOnlyAllowedFields(line);
    expect(hits(`${exit.output}\n${file}`)).toEqual([]);
    expect(file).not.toContain("/api/health");
  });
});
