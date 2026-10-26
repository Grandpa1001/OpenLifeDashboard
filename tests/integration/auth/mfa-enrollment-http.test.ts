// D11.1 — enrolling the second factor over real HTTP on the built server and a real database
// (Architektura §9.7, §18.7). The owner is made by the real CLI, the codes come from the secret the
// server hands out (the way an authenticator app computes them), the clock is the real one: a
// step later than the last used one is the code of the next time step, which the window accepts.
// AC1: confirming a TOTP does not open the data before the acknowledgment; a lost view leads, by
//      the next TOTP, to a new batch while the confirmed secret stays; the current acknowledgment
//      completes the enrollment.
// AC2: a foreign or expired challenge, a late acknowledgment and an old batch are refused; begin
//      never resets an active factor; the plain codes are not in the database or the logs; a
//      failing audit gives 503 with no cookie, no codes and no change.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { enrollmentChallengeSchema, issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { createOTP } from "@better-auth/utils/otp";
import { afterEach, describe, expect, it } from "vitest";
import { authCookiePrefix } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { repoRoot, runBuiltScript, startBuiltServer, startedInstallation, waitForExit, type ServerProcess } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");
const EMAIL = "owner@example.test";
const PASSWORD = "a passphrase for the enrollment";
const ORIGIN = "http://localhost:8080";

const running: ServerProcess[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    if (server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, 15_000);
    }
  }
});

type Installation = Readonly<{ instance: TestInstance; server: ServerProcess }>;

async function installation(): Promise<Installation> {
  const instance = await startedInstallation();
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: EMAIL, password: PASSWORD }));
  expect(created.code, created.output).toBe(0);
  const server = await startBuiltServer({ installation: { dir: instance.dir, env: instance.env } });
  running.push(server);
  return { instance, server };
}

type Reply = Readonly<{ status: number; headers: Headers; text: string; json: () => unknown; cookie: string | null }>;

async function post(server: ServerProcess, route: string, body: unknown, init: { cookie?: string | null; origin?: string | null } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers["Origin"] = origin;
  if (init.cookie) headers["Cookie"] = init.cookie;
  const response = await fetch(`${server.baseUrl}${route}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) as unknown, cookie: response.headers.getSetCookie()[0]?.split(";")[0] ?? null };
}

const signIn = (server: ServerProcess) => post(server, "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD });
const begin = (server: ServerProcess, cookie: string | null) => post(server, "/api/v1/mfa/enrollment/begin", {}, { cookie });
const confirm = (server: ServerProcess, cookie: string | null, challengeId: string, code: string) => post(server, "/api/v1/mfa/enrollment/confirm", { challengeId, code }, { cookie });
const reissue = (server: ServerProcess, cookie: string | null, code: string) => post(server, "/api/v1/mfa/enrollment/recovery/reissue", { code }, { cookie });
const ack = (server: ServerProcess, cookie: string | null, batchId: string) => post(server, "/api/v1/mfa/enrollment/recovery/ack", { batchId }, { cookie });
async function status(server: ServerProcess, cookie: string | null) {
  const response = await fetch(`${server.baseUrl}/api/v1/identity/status`, { headers: cookie ? { Cookie: cookie } : {} });
  return identityStatusSchema.parse(await response.json());
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The secret bytes of an otpauth URI, the way an authenticator app reads them. */
function secretOf(otpauthUri: string): Buffer {
  const encoded = new URL(otpauthUri).searchParams.get("secret") ?? "";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.replace(/=+$/, "")) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}
const codeOf = (secret: Buffer, stepOffset = 0): Promise<string> => createOTP(secret, { digits: 6, period: 30 }).hotp(Math.floor(Date.now() / 30_000) + stepOffset);

function query<T>(instance: TestInstance, sql: string): T[] {
  const reader = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return reader.handle.prepare(sql).all() as T[];
  } finally {
    reader.close();
  }
}
const mfaState = (instance: TestInstance) =>
  query<{ enrollment_state: string; secret_generation: number; active_secret: string | null; pending_challenge_id: string | null; recovery_batch_id: string | null }>(
    instance,
    "SELECT enrollment_state, secret_generation, active_secret, pending_challenge_id, recovery_batch_id FROM mfa_state",
  )[0];
const count = (instance: TestInstance, table: string): number => query<{ n: number }>(instance, `SELECT count(*) AS n FROM "${table}"`)[0]?.n ?? -1;

/** Password session → begin → confirm: the common start. */
async function enrolled(setup: Installation) {
  const login = await signIn(setup.server);
  const passwordCookie = login.cookie ?? "";
  const challenge = enrollmentChallengeSchema.parse((await begin(setup.server, passwordCookie)).json());
  const secret = secretOf(challenge.otpauthUri);
  const confirmed = await confirm(setup.server, passwordCookie, challenge.challengeId, await codeOf(secret));
  return { passwordCookie, challenge, secret, confirmed, codes: confirmed.status === 200 ? issuedRecoveryCodesSchema.parse(confirmed.json()) : null };
}

describe("D11.1-AC1 begin → confirm → acknowledge", () => {
  it("runs end to end: the data stay closed until the acknowledgment, the session is promoted, the codes are shown once", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const login = await signIn(server);
    expect(identityStatusSchema.parse(login.json())).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });

    const started = await begin(server, login.cookie);
    expect(started.status).toBe(200);
    expect(started.headers.get("cache-control")).toBe("no-store");
    const challenge = enrollmentChallengeSchema.parse(started.json());
    expect(challenge.otpauthUri).toMatch(/^otpauth:\/\/totp\/OpenLifeDashboard:owner%40example\.test\?secret=[A-Z2-7]+&issuer=OpenLifeDashboard&digits=6&period=30$/);
    expect(challenge.manualKey).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4})+$/);
    expect(new Date(challenge.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    // Beginning again returns the same challenge and the same secret: no second secret is made.
    const again = enrollmentChallengeSchema.parse((await begin(server, login.cookie)).json());
    expect(again).toEqual(challenge);
    expect(mfaState(instance)).toMatchObject({ enrollment_state: "required", secret_generation: 0, active_secret: null });

    const secret = secretOf(challenge.otpauthUri);
    const confirmed = await confirm(server, login.cookie, challenge.challengeId, await codeOf(secret));
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
    expect(issued.nextAction).toBe("recovery_ack");
    expect(new Set(issued.recoveryCodes).size).toBe(10);
    // The promoted session replaced the password session: another cookie, the old one is dead.
    expect(confirmed.cookie).toMatch(new RegExp(`^${authCookiePrefix(instance.instanceId).replace(".", "\\.")}\\.session_token=`));
    expect(confirmed.cookie).not.toBe(login.cookie);
    expect(await status(server, login.cookie)).toEqual({ authenticated: false, nextAction: "login" });
    // Confirmed, but not acknowledged: authenticated, and the next step is the acknowledgment, not the data.
    expect(await status(server, confirmed.cookie)).toEqual({ authenticated: true, nextAction: "recovery_ack" });
    expect(mfaState(instance)).toMatchObject({ enrollment_state: "awaiting_recovery_ack", secret_generation: 1, pending_challenge_id: null, recovery_batch_id: issued.batchId });
    expect(query(instance, "SELECT assurance FROM session_ext")).toEqual([{ assurance: "totp" }]);

    const acknowledged = await ack(server, confirmed.cookie, issued.batchId);
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.json()).toEqual({ nextAction: "setup_data" });
    expect(await status(server, confirmed.cookie)).toEqual({ authenticated: true, nextAction: "setup_data" });
    expect(mfaState(instance)?.enrollment_state).toBe("complete");
    // Acknowledging the same batch again is harmless.
    expect((await ack(server, confirmed.cookie, issued.batchId)).status).toBe(200);
    expect(query(instance, "SELECT action FROM audit_log WHERE action LIKE 'mfa.%' ORDER BY id")).toEqual([
      { action: "mfa.enrollment_started" },
      { action: "mfa.enrolled" },
      { action: "mfa.recovery_acknowledged" },
    ]);
  });

  it("a lost view of the codes: the next TOTP issues a new batch for the new session, the confirmed secret stays", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const first = await enrolled(setup);
    const firstBatch = first.codes?.batchId ?? "";
    const activeSecret = mfaState(instance)?.active_secret;
    expect(activeSecret).toBeTruthy();

    // The response is lost: no codes, no cookie. The owner signs in again; the data are still closed.
    const relogin = await signIn(server);
    expect(identityStatusSchema.parse(relogin.json())).toEqual({ authenticated: true, nextAction: "recovery_ack" });
    // This session was not shown the batch: it cannot acknowledge it.
    expect((await ack(server, relogin.cookie, firstBatch)).status).toBe(409);
    expect(mfaState(instance)?.enrollment_state).toBe("awaiting_recovery_ack");
    // The code of the step already used is refused; the next step's code is a fresh proof.
    expect((await reissue(server, relogin.cookie, await codeOf(first.secret))).status).toBe(401);
    const reissued = await reissue(server, relogin.cookie, await codeOf(first.secret, 1));
    expect(reissued.status).toBe(200);
    const second = issuedRecoveryCodesSchema.parse(reissued.json());
    expect(second.batchId).not.toBe(firstBatch);
    expect(second.recoveryCodes.filter((code) => first.codes?.recoveryCodes.includes(code))).toEqual([]);
    expect(reissued.cookie).not.toBe(relogin.cookie);
    expect(await status(server, relogin.cookie)).toEqual({ authenticated: false, nextAction: "login" });

    // The old batch is gone for good; only the current one acknowledges.
    const lateAck = await ack(server, reissued.cookie, firstBatch);
    expect(lateAck.status).toBe(409);
    expect(apiErrorSchema.parse(lateAck.json()).code).toBe("RECOVERY_BATCH_CHANGED");
    expect(query(instance, "SELECT DISTINCT batch_id FROM recovery_code")).toEqual([{ batch_id: second.batchId }]);
    expect(count(instance, "recovery_code")).toBe(10);
    expect((await ack(server, reissued.cookie, second.batchId)).status).toBe(200);
    expect(await status(server, reissued.cookie)).toEqual({ authenticated: true, nextAction: "setup_data" });
    // The factor itself was never replaced.
    expect(mfaState(instance)).toMatchObject({ enrollment_state: "complete", secret_generation: 1, active_secret: activeSecret });
  });

  it("an enrolled owner cannot be reset by beginning again; the secret and the state stay", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const first = await enrolled(setup);
    const before = mfaState(instance);
    // While the acknowledgment is awaited and once the enrollment is complete, begin is refused.
    const awaiting = await begin(server, first.confirmed.cookie);
    expect(awaiting.status).toBe(409);
    expect(apiErrorSchema.parse(awaiting.json()).code).toBe("ENROLLMENT_CHANGED");
    expect((await ack(server, first.confirmed.cookie, first.codes?.batchId ?? "")).status).toBe(200);
    const complete = await begin(server, first.confirmed.cookie);
    expect(complete.status).toBe(409);
    expect(apiErrorSchema.parse(complete.json()).code).toBe("ENROLLMENT_CHANGED");
    // The old password session is gone since the promotion: it cannot begin anything either.
    expect((await begin(server, first.passwordCookie)).status).toBe(401);
    expect(mfaState(instance)).toMatchObject({ secret_generation: 1, active_secret: before?.active_secret, pending_challenge_id: null });
  });
});

describe("D11.1-AC2 refusals", () => {
  it("a wrong code is 401 MFA_INVALID_CODE and changes nothing; the challenge stays usable", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const login = await signIn(server);
    const challenge = enrollmentChallengeSchema.parse((await begin(server, login.cookie)).json());
    const secret = secretOf(challenge.otpauthUri);
    const wrong = await confirm(server, login.cookie, challenge.challengeId, "000000");
    expect(wrong.status).toBe(401);
    expect(apiErrorSchema.parse(wrong.json()).code).toBe("MFA_INVALID_CODE");
    // A code two steps away is no better than a wrong one.
    expect((await confirm(server, login.cookie, challenge.challengeId, await codeOf(secret, 2))).status).toBe(401);
    expect(wrong.cookie).toBeNull();
    expect(mfaState(instance)).toMatchObject({ enrollment_state: "required", secret_generation: 0, pending_challenge_id: challenge.challengeId });
    expect((await confirm(server, login.cookie, challenge.challengeId, await codeOf(secret))).status).toBe(200);
  });

  it("a challenge of another session, an unknown one and an expired one are refused with ENROLLMENT_CHANGED", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const mine = await signIn(server);
    const other = await signIn(server);
    const challenge = enrollmentChallengeSchema.parse((await begin(server, mine.cookie)).json());
    const secret = secretOf(challenge.otpauthUri);
    for (const [cookie, id] of [
      [other.cookie, challenge.challengeId],
      [mine.cookie, "not-the-challenge"],
    ] as const) {
      const refused = await confirm(server, cookie, id, await codeOf(secret));
      expect(refused.status).toBe(409);
      expect(apiErrorSchema.parse(refused.json()).code).toBe("ENROLLMENT_CHANGED");
    }
    expect(mfaState(instance)).toMatchObject({ secret_generation: 0, active_secret: null });

    const writer = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.exec("UPDATE mfa_state SET pending_expires_at_ms = pending_expires_at_ms - 11 * 60 * 1000");
    writer.close();
    const expired = await confirm(server, mine.cookie, challenge.challengeId, await codeOf(secret));
    expect(expired.status).toBe(409);
    expect(mfaState(instance)?.secret_generation).toBe(0);
    // An expired challenge is replaced by beginning again: a new secret for the same session.
    const fresh = enrollmentChallengeSchema.parse((await begin(server, mine.cookie)).json());
    expect(fresh.challengeId).not.toBe(challenge.challengeId);
    expect(fresh.otpauthUri).not.toBe(challenge.otpauthUri);
  });

  it("of two confirmations of one challenge with one code exactly one succeeds", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const login = await signIn(server);
    const challenge = enrollmentChallengeSchema.parse((await begin(server, login.cookie)).json());
    const code = await codeOf(secretOf(challenge.otpauthUri));
    const replies = await Promise.all([confirm(server, login.cookie, challenge.challengeId, code), confirm(server, login.cookie, challenge.challengeId, code)]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    expect(count(instance, "recovery_code")).toBe(10);
    expect(query(instance, "SELECT count(*) AS n FROM session_ext WHERE assurance = 'totp'")).toEqual([{ n: 1 }]);
  });

  it("the same code cannot be used again for the reissue", async () => {
    const setup = await installation();
    const { server } = setup;
    const first = await enrolled(setup);
    const used = await codeOf(first.secret);
    const refused = await reissue(server, first.confirmed.cookie, used);
    expect(refused.status).toBe(401);
    expect(apiErrorSchema.parse(refused.json()).code).toBe("MFA_INVALID_CODE");
  });

  it("only the owner's live session may enroll: no cookie, a forged one and a foreign Origin are refused before anything is read", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const login = await signIn(server);
    expect((await begin(server, null)).status).toBe(401);
    expect((await begin(server, `${login.cookie ?? ""}x`)).status).toBe(401);
    for (const origin of [null, "https://evil.example", "http://localhost:3000"]) {
      const refused = await post(server, "/api/v1/mfa/enrollment/begin", {}, { cookie: login.cookie, origin });
      expect(refused.status).toBe(403);
    }
    expect(mfaState(instance)?.pending_challenge_id).toBeNull();
    for (const [route, body] of [
      ["/api/v1/mfa/enrollment/begin", { extra: 1 }],
      ["/api/v1/mfa/enrollment/confirm", { challengeId: "x", code: "12345" }],
      ["/api/v1/mfa/enrollment/confirm", { challengeId: "x", code: "123456", assurance: "totp" }],
      ["/api/v1/mfa/enrollment/recovery/reissue", { code: "abcdef" }],
      ["/api/v1/mfa/enrollment/recovery/ack", {}],
      ["/api/v1/mfa/enrollment/recovery/ack", "not json"],
    ] as const) {
      const refused = await post(server, route, body, { cookie: login.cookie });
      expect(refused.status, route).toBe(422);
    }
  });

  it("a failing audit is 503 with no cookie and no codes, and nothing changes; after repair the same code works", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const login = await signIn(server);
    const challenge = enrollmentChallengeSchema.parse((await begin(server, login.cookie)).json());
    const code = await codeOf(secretOf(challenge.otpauthUri));
    const writer = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.exec(`CREATE TRIGGER fail_enrolled BEFORE INSERT ON audit_log WHEN new.action = 'mfa.enrolled' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const failed = await confirm(server, login.cookie, challenge.challengeId, code);
    expect(failed.status).toBe(503);
    expect(failed.cookie).toBeNull();
    expect(apiErrorSchema.parse(failed.json()).code).toBe("AUTH_UNAVAILABLE");
    expect(failed.text).not.toMatch(/recoveryCodes|audit unavailable/);
    expect(mfaState(instance)).toMatchObject({ enrollment_state: "required", secret_generation: 0, pending_challenge_id: challenge.challengeId });
    expect(count(instance, "recovery_code")).toBe(0);
    expect(await status(server, login.cookie)).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
    writer.handle.exec("DROP TRIGGER fail_enrolled");
    writer.close();
    expect((await confirm(server, login.cookie, challenge.challengeId, code)).status).toBe(200);
  });

  it("the plain codes and the secret are in no database file and no log; only hashes are stored", async () => {
    const setup = await installation();
    const { instance, server } = setup;
    const first = await enrolled(setup);
    const codes = first.codes?.recoveryCodes ?? [];
    expect(codes).toHaveLength(10);
    const writer = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.pragma("wal_checkpoint(TRUNCATE)");
    writer.close();
    const rows = query<{ code_hash: string }>(instance, "SELECT code_hash FROM recovery_code");
    expect(rows).toHaveLength(10);
    const database = readFileSync(path.join(instance.dir, "data", "app.db")).toString("latin1");
    const logs = [server.output(), readFileSync(path.join(instance.dir, "data", "logs", "app", "app.jsonl"), "utf8")];
    const secretText = new URL(first.challenge.otpauthUri).searchParams.get("secret") ?? "";
    for (const code of codes) {
      for (const needle of [code, code.replace("-", ""), code.toLowerCase()]) {
        expect(database).not.toContain(needle);
        for (const log of logs) expect(log).not.toContain(needle);
      }
      expect(rows.some((row) => row.code_hash === code)).toBe(false);
    }
    expect(database).not.toContain(secretText);
    expect(database).not.toContain(first.secret.toString("latin1"));
    for (const log of logs) {
      expect(log).not.toContain(secretText);
      expect(log).not.toContain("otpauth://");
    }
  });
});
