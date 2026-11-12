// D44.2 — the files of the technical log over HTTP, on the in-process app of the harness (Architektura §15.3;
// DEV §9.41).
// AC1: no session is 401 and a session that has not passed the gate is refused; the list holds only the
//      names the sink writes, the active file first and then the rotated ones, newest first; a file of the
//      list is downloaded as it is with the headers of an attachment; a name that is not on the list, a
//      path with a traversal (plain or encoded) and a name of the right shape that is not there are 404.
// AC2: a link, a file over the bound and a rotated file older than the retention are neither listed nor
//      downloaded; a request id finds the lines whose own request id it is (not a longer id that contains
//      it, not a value that mentions it), oldest first, over the active and the rotated files; a
//      malformed id is 422; the lines are cut at the limit and the search says so.
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { DIAGNOSTICS_LOGS_PATH, diagnosticsLogPath, diagnosticsRequestPath, logFileListSchema, requestLogSchema } from "@openlife/contracts/http/diagnostics";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type HarnessOptions } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

const MARKER = "MARKER-secret-value-7d1e55";
const ROTATED_NEW = "app.20990101T000000Z-000.jsonl";
const ROTATED_MID = "app.20980101T000000Z-000.jsonl";
const ROTATED_OLD = "app.20200101T000000Z-000.jsonl";

async function owner(options: HarnessOptions = {}) {
  const h = await createAppHarness(options);
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  const get = (route: string, cookie: string | null = a) => h.request("GET", route, undefined, { cookie });
  const file = (name: string, content: string): string => {
    const target = path.join(h.logsDir, name);
    writeFileSync(target, content);
    return target;
  };
  return { h, a, get, file, passwordOnly: async () => (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "" };
}

const entry = (requestId: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ timestamp: "2026-11-12T10:00:00.000Z", level: "info", event: "http.request", requestId, ...extra });
const names = (body: unknown): string[] => logFileListSchema.parse(body).files.map((file) => file.name);

describe("D44.2-AC1 the list, the download and the names that are refused", () => {
  it("answers 401 without a session and the code of the gate before the session has passed it, on each route", async () => {
    const { h, get, file, passwordOnly } = await owner();
    file("app.jsonl", entry("req-1") + "\n");
    for (const route of [DIAGNOSTICS_LOGS_PATH, diagnosticsLogPath("app.jsonl"), diagnosticsRequestPath("req-1")]) {
      const anonymous = await get(route, null);
      expect([anonymous.status, apiErrorSchema.parse(anonymous.json()).code], route).toEqual([401, "AUTH_REQUIRED"]);
      const early = await get(route, await passwordOnly());
      expect([early.status, apiErrorSchema.parse(early.json()).code], route).toEqual([403, "MFA_REQUIRED"]);
    }
    expect(h.logLines().join("\n")).not.toContain(MARKER);
  });

  it("lists the active file first, then the rotated ones newest first, and no other file of the folder", async () => {
    const { h, get, file } = await owner();
    file("app.jsonl", entry("req-1") + "\n");
    file(ROTATED_MID, entry("req-2") + "\n");
    file(ROTATED_NEW, entry("req-3") + "\n");
    for (const stranger of [".env", "notes.txt", "app.jsonl.bak", "app.jsonl~", "updater.jsonl", "app.2026-11-12.jsonl", "app.20261112T000000Z-0.jsonl"]) file(stranger, MARKER);
    mkdirSync(path.join(h.logsDir, "x"));
    const reply = await get(DIAGNOSTICS_LOGS_PATH);
    expect(reply.status).toBe(200);
    expect(names(reply.json())).toEqual(["app.jsonl", ROTATED_NEW, ROTATED_MID]);
    const files = logFileListSchema.parse(reply.json()).files;
    expect(files.map((listed) => listed.active)).toEqual([true, false, false]);
    expect(files[0]?.bytes).toBe(Buffer.byteLength(entry("req-1") + "\n"));
    expect(reply.text).not.toContain(MARKER);
  });

  it("downloads a file of the list as it is, as an attachment that is not rendered, and nothing is cached", async () => {
    const { h, a, file } = await owner();
    const content = [entry("req-1"), entry("req-2", { code: "SOME_CODE" })].join("\n") + "\n";
    file("app.jsonl", content);
    const response = await h.open(diagnosticsLogPath("app.jsonl"), { cookie: a });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="app.jsonl"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(content)));
    expect(await response.text()).toBe(content);
  });

  it("downloads an empty file as an empty body", async () => {
    const { h, a, file } = await owner();
    file("app.jsonl", "");
    const response = await h.open(diagnosticsLogPath("app.jsonl"), { cookie: a });
    expect([response.status, await response.text()]).toEqual([200, ""]);
  });

  it("refuses a name that is not on the list, a traversal in any spelling and a name of the right shape that is not there, all as 404", async () => {
    const { h, a, file } = await owner();
    file("app.jsonl", entry("req-1") + "\n");
    file(".env", MARKER);
    writeFileSync(path.join(h.installationDir, "secret.txt"), MARKER);
    for (const name of [".env", "notes.txt", "../secret.txt", "..%2Fsecret.txt", "%2E%2E%2Fsecret.txt", "..%5Csecret.txt", "app.jsonl%00.txt", "%2Fetc%2Fpasswd", ROTATED_NEW]) {
      const reply = await h.request("GET", `${DIAGNOSTICS_LOGS_PATH}/${name}`, undefined, { cookie: a });
      expect(reply.status, name).toBe(404);
      expect(reply.text, name).not.toContain(MARKER);
    }
  });
});

describe("D44.2-AC2 the files that are refused and the search by request id", () => {
  it("neither lists nor downloads a link, a file over the bound or a rotated file older than the retention", async () => {
    const { h, a, get, file } = await owner({ logFileMaxBytes: 200 });
    file("app.jsonl", entry("req-1") + "\n");
    file(ROTATED_NEW, entry("req-big", { note: "x".repeat(400) }) + "\n");
    file(ROTATED_OLD, entry("req-old") + "\n");
    const elsewhere = path.join(h.installationDir, "elsewhere.jsonl");
    writeFileSync(elsewhere, entry("req-linked", { password: MARKER }) + "\n");
    symlinkSync(elsewhere, path.join(h.logsDir, ROTATED_MID));
    expect(names((await get(DIAGNOSTICS_LOGS_PATH)).json())).toEqual(["app.jsonl"]);
    for (const name of [ROTATED_NEW, ROTATED_OLD, ROTATED_MID]) {
      const response = await h.open(diagnosticsLogPath(name), { cookie: a });
      expect(response.status, name).toBe(404);
      expect(await response.text(), name).not.toContain(MARKER);
    }
    // A link in place of the active file is refused too.
    unlinkSync(path.join(h.logsDir, "app.jsonl"));
    symlinkSync(elsewhere, path.join(h.logsDir, "app.jsonl"));
    expect(names((await get(DIAGNOSTICS_LOGS_PATH)).json())).toEqual([]);
    const active = await h.open(diagnosticsLogPath("app.jsonl"), { cookie: a });
    expect(active.status).toBe(404);
    expect(await active.text()).not.toContain(MARKER);
  });

  it("finds the lines whose own request id it is, oldest first, over the active and the rotated files", async () => {
    const { get, file } = await owner();
    file(ROTATED_MID, [entry("req-1", { event: "http.request" }), entry("req-2")].join("\n") + "\n");
    file(ROTATED_NEW, [entry("req-1", { event: "second.event" }), entry("req-10")].join("\n") + "\n");
    file("app.jsonl", [entry("req-3", { note: "see req-1 for the cause" }), entry("req-1", { event: "third.event", code: "X_Y" }), "not json req-1", ""].join("\n"));
    const reply = await get(diagnosticsRequestPath("req-1"));
    expect(reply.status).toBe(200);
    const body = requestLogSchema.parse(reply.json());
    expect(body.requestId).toBe("req-1");
    expect(body.lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(["http.request", "second.event", "third.event"]);
    expect(body).toMatchObject({ truncated: false, filesSearched: 3 });
    const none = requestLogSchema.parse((await get(diagnosticsRequestPath("req-nothing"))).json());
    expect(none).toMatchObject({ lines: [], truncated: false });
  });

  it("refuses a malformed request id with 422 and returns nothing of the folder", async () => {
    const { get, file } = await owner();
    file("app.jsonl", entry("req-1") + "\n");
    for (const bad of ["a b", "x".repeat(65), "req.1", "req_1", ".*", "a%2Fb"]) {
      const reply = await get(`/api/v1/diagnostics/requests/${bad.includes("%") ? bad : encodeURIComponent(bad)}`);
      expect([reply.status, apiErrorSchema.parse(reply.json()).code], bad).toEqual([422, "VALIDATION_FAILED"]);
    }
  });

  it("cuts the lines at the limit and says so", async () => {
    const { get, file } = await owner();
    file("app.jsonl", Array.from({ length: 120 }, (_, n) => entry("req-many", { n })).join("\n") + "\n");
    const body = requestLogSchema.parse((await get(diagnosticsRequestPath("req-many"))).json());
    expect(body.lines).toHaveLength(100);
    expect(body.truncated).toBe(true);
    expect((JSON.parse(body.lines[0] ?? "{}") as { n: number }).n).toBe(0);
  });

  it("stops the search when the files together are more than it reads, and says so", async () => {
    const { get, file } = await owner({ logSearchMaxBytes: 150 });
    const line = entry("req-1") + "\n";
    file(ROTATED_MID, line);
    file("app.jsonl", line);
    expect(Buffer.byteLength(line) * 2).toBeGreaterThan(150);
    const body = requestLogSchema.parse((await get(diagnosticsRequestPath("req-1"))).json());
    expect(body).toMatchObject({ truncated: true, filesSearched: 1 });
    expect(body.lines).toHaveLength(1);
  });
});
