// D44.1 — the overview of the installation over HTTP, on the in-process app of the harness (Architektura §15.3;
// DEV §9.41).
// AC1: no session is 401 and a session that does not pass the gate of the data is refused with its code;
//      the owner gets the versions, the paths of the host and of the container, the sizes and the state
//      of the log, in the shape of the contract.
// AC2: the latest errors come from the end of the active log, newest first, as a time, an event, a code and
//      a request id only; a line that is not an error, is not JSON or has a field of the wrong shape is
//      left out; a log that is a link or is missing gives no errors; what the log holds besides never
//      reaches the answer; the parts without a module say so.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { DIAGNOSTICS_PATH, diagnosticsSchema } from "@openlife/contracts/http/diagnostics";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

const SECRET_MARKER = "MARKER-secret-value-4f2a9c";

/** The owner past the gate of the data, and the log file the diagnostics read. */
async function owner() {
  const h = await createAppHarness();
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  /** A new sign-in: the password only, the second factor not yet given. */
  const passwordOnly = async (): Promise<string> => (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const overview = async (cookie: string | null = a) => h.request("GET", DIAGNOSTICS_PATH, undefined, { cookie });
  const logFile = path.join(h.logsDir, "app.jsonl");
  return { h, a, passwordOnly, overview, logFile };
}

const line = (fields: Record<string, unknown>): string => JSON.stringify({ timestamp: "2026-11-12T10:00:00.000Z", level: "error", service: "openlife-app", ...fields });

describe("D44.1-AC1 the gate and the shape of the overview", () => {
  it("answers 401 without a session and the code of the gate for a session that has not passed it", async () => {
    const { h, passwordOnly, overview } = await owner();
    const anonymous = await overview(null);
    expect([anonymous.status, apiErrorSchema.parse(anonymous.json()).code]).toEqual([401, "AUTH_REQUIRED"]);
    expect(apiErrorSchema.parse(anonymous.json()).requestId).toBeTruthy();
    const password = await overview(await passwordOnly());
    expect([password.status, apiErrorSchema.parse(password.json()).code]).toEqual([403, "MFA_REQUIRED"]);
    expect(h.logLines().join("\n")).not.toContain(SECRET_MARKER);
  });

  it("gives the owner the versions, the paths of the host and of the container, the sizes and the state of the log", async () => {
    const { h, overview } = await owner();
    const reply = await overview();
    expect(reply.status).toBe(200);
    expect(reply.setCookies).toEqual([]);
    const body = diagnosticsSchema.parse(reply.json());
    expect(body.app).toMatchObject({ version: "0.0.0", revision: "harness", schemaVersion: 17, installMode: "local", hostPlatform: "posix" });
    expect(body.paths.host.installation).toBe(h.installationDir);
    expect(body.paths.host.database).toBe(path.join(h.installationDir, "data", "app.db"));
    expect(body.paths.host.logs).toBe(path.join(h.installationDir, "data", "logs", "app"));
    expect(body.paths.container).toMatchObject({ database: "/data/app.db", logs: "/data/logs/app", backups: "/data/backup" });
    expect(body.storage.databaseBytes).toBeGreaterThan(0);
    expect(body.storage.dataFreeBytes).toBeGreaterThan(0);
    expect(body.logger).toEqual({ degraded: false, lostLines: 0, queuedBytes: 0 });
    expect(body.live.connections).toBe(0);
    expect(body.recentErrors).toEqual([]);
  });

  it("counts the open streams of every session", async () => {
    const { h, a, overview } = await owner();
    const stream = await h.open("/api/v1/stream", { cookie: a });
    try {
      expect(diagnosticsSchema.parse((await overview()).json()).live.connections).toBe(1);
    } finally {
      await stream.body?.cancel();
    }
  });
});

describe("D44.1-AC2 the latest errors and the parts without a module", () => {
  it("lists the errors of the active log newest first with a time, an event, a code and a request id, and nothing else of the lines", async () => {
    const { overview, logFile } = await owner();
    writeFileSync(
      logFile,
      [
        line({ timestamp: "2026-11-12T09:00:00.000Z", event: "http.unhandled_error", code: "INTERNAL_ERROR", requestId: "req-1", error: { name: "TypeError", message: SECRET_MARKER } }),
        line({ level: "info", event: "http.request", requestId: "req-2" }),
        "this line is not JSON",
        line({ timestamp: "2026-11-12T09:30:00.000Z", event: "settings.stored_invalid", code: "CONFIG_INVALID", requestId: null, password: SECRET_MARKER }),
        line({ timestamp: "not a time", event: "x.y" }),
        line({ event: "Bad Event Name" }),
        line({ timestamp: "2026-11-12T09:45:00.000Z", event: "session.unavailable", code: "lower case code", requestId: "bad id with spaces" }),
        "",
      ].join("\n"),
    );
    const reply = await overview();
    const body = diagnosticsSchema.parse(reply.json());
    expect(body.recentErrors).toEqual([
      { at: "2026-11-12T09:45:00.000Z", event: "session.unavailable", code: null, requestId: null },
      { at: "2026-11-12T09:30:00.000Z", event: "settings.stored_invalid", code: "CONFIG_INVALID", requestId: null },
      { at: "2026-11-12T09:00:00.000Z", event: "http.unhandled_error", code: "INTERNAL_ERROR", requestId: "req-1" },
    ]);
    expect(reply.text).not.toContain(SECRET_MARKER);
  });

  it("shows at most ten errors, reads only the end of a long log and drops the piece of a line it starts in", async () => {
    const { overview, logFile } = await owner();
    const filler = line({ level: "info", event: "http.request", requestId: "filler", note: "x".repeat(900) });
    const errors = Array.from({ length: 14 }, (_, n) => line({ timestamp: `2026-11-12T10:${String(n).padStart(2, "0")}:00.000Z`, event: "job.failed", code: "JOB_FAILED", requestId: `req-${n}` }));
    // More than the tail that is read: the first lines are never looked at.
    const head = line({ timestamp: "2026-01-01T00:00:00.000Z", event: "old.error", code: "OLD", requestId: "old" });
    writeFileSync(logFile, [head, ...Array.from({ length: 400 }, () => filler), ...errors].join("\n") + "\n");
    const body = diagnosticsSchema.parse((await overview()).json());
    expect(body.recentErrors).toHaveLength(10);
    expect(body.recentErrors[0]?.requestId).toBe("req-13");
    expect(body.recentErrors[9]?.requestId).toBe("req-4");
    expect(body.recentErrors.some((error) => error.event === "old.error")).toBe(false);
  });

  it("gives no errors when the active log is a link or does not exist, and the overview still answers", async () => {
    const { h, overview, logFile } = await owner();
    expect(diagnosticsSchema.parse((await overview()).json()).recentErrors).toEqual([]);
    const elsewhere = path.join(h.installationDir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, "app.jsonl"), line({ event: "linked.error", code: "LINKED" }) + "\n");
    symlinkSync(path.join(elsewhere, "app.jsonl"), logFile);
    const reply = await overview();
    expect(reply.status).toBe(200);
    expect(diagnosticsSchema.parse(reply.json()).recentErrors).toEqual([]);
  });

  it("says that the backup, the updater and the schedulers are not available instead of inventing a state", async () => {
    const { overview } = await owner();
    expect(diagnosticsSchema.parse((await overview()).json()).parts).toEqual({ backup: "not_available", updater: "not_available", schedulers: "not_available" });
  });
});
