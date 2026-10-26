// D11.2 — proving the second factor over real HTTP: a TOTP or a recovery code at login, trusted
// devices and the step-up (Architektura §9.3, §9.7, §18.7). Real server, real database, an owner
// made by the CLI, codes computed from the secret like an authenticator app; the starting data
// are chosen in SQL where D11.4 will do it over HTTP.
// AC1: of two parallel requests with one TOTP step or one recovery code exactly one succeeds
//      (F09 parallel-totp-use, parallel-recovery-use); a recovery code lowers the rest by one and
//      gives neither a fresh TOTP nor trust; a proof rotates the session (F09
//      mfa-promotion-rotates-session); a trusted device stands in for the factor at login only.
// AC2: a used step, a revoked or expired device and a lost response open nothing; a failing audit
//      spends no factor and publishes no session or cookie.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { mfaVerifiedSchema } from "@openlife/contracts/http/mfa";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authCookiePrefix } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import {
  RESET_PASSWORD,
  codeOf,
  count,
  enrolled,
  execute,
  installation,
  mfaState,
  OWNER_PASSWORD,
  post,
  query,
  readyOwner,
  serve,
  signIn,
  status,
  stepUp,
  stopServer,
  stopServers,
  verify,
  type Installation,
} from "../../support/auth-http.ts";
import { runBuiltScript } from "../../support/server-process.ts";

afterEach(stopServers);

const sessions = (setup: Installation) =>
  query<{ assurance: string; totp: number | null; trusted: string | null }>(setup.instance, "SELECT assurance, totp_verified_at_ms AS totp, trusted_device_id AS trusted FROM session_ext ORDER BY assurance");
const sessionCookieName = (setup: Installation): string => `${authCookiePrefix(setup.instance.instanceId)}.session_token`;
const trustedCookieName = (setup: Installation): string => `${authCookiePrefix(setup.instance.instanceId)}.trusted_device`;
const auditActions = (setup: Installation, like: string): string[] => query<{ action: string }>(setup.instance, `SELECT action FROM audit_log WHERE action LIKE '${like}' ORDER BY id`).map((row) => row.action);

describe("D11.2-AC1 a TOTP at login", () => {
  it("F09 mfa-promotion-rotates-session: the TOTP opens the data, the session is rotated and the old cookie is dead", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    expect(await status(setup.server, login.cookie)).toEqual({ authenticated: true, nextAction: "mfa_challenge" });

    const proved = await verify(setup.server, login.cookie, { code: await codeOf(owner.secret, 1) });
    expect(proved.status).toBe(200);
    expect(proved.headers.get("cache-control")).toBe("no-store");
    expect(mfaVerifiedSchema.parse(proved.json())).toEqual({ nextAction: "ready" });
    expect(proved.cookies).toHaveLength(1);
    expect(proved.cookie).not.toBe(login.cookie);
    expect(await status(setup.server, login.cookie)).toEqual({ authenticated: false, nextAction: "login" });
    expect(await status(setup.server, proved.cookie)).toEqual({ authenticated: true, nextAction: "ready" });
    expect(sessions(setup).filter((row) => row.assurance === "totp")).toHaveLength(2);
    expect(auditActions(setup, "mfa.verified")).toEqual(["mfa.verified"]);
    // No trusted device without the owner's explicit choice.
    expect(count(setup.instance, "trusted_device")).toBe(0);
  });

  it("F09 parallel-totp-use: two password sessions, one TOTP step: one success and one 401", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const [first, second] = [await signIn(setup.server), await signIn(setup.server)];
    const code = await codeOf(owner.secret, 1);
    const replies = await Promise.all([verify(setup.server, first.cookie, { code }), verify(setup.server, second.cookie, { code })]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
    const refused = replies.find((reply) => reply.status === 401);
    expect(apiErrorSchema.parse(refused?.json()).code).toBe("MFA_INVALID_CODE");
    expect(refused?.cookies).toEqual([]);
    // The refused request left its session as it was: a password session, no TOTP time.
    expect(sessions(setup).filter((row) => row.assurance === "password")).toHaveLength(1);
    expect(auditActions(setup, "mfa.verified")).toHaveLength(1);
  });

  it("a step that was used, one before it and a code of another secret are refused; the lost response does not allow a second use", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    const code = await codeOf(owner.secret, 1);
    expect((await verify(setup.server, login.cookie, { code })).status).toBe(200);
    const consumed = mfaState(setup.instance)?.last_used_step;
    // The answer is lost; the owner signs in again and tries the same code, then the one before it.
    const again = await signIn(setup.server);
    for (const stale of [code, await codeOf(owner.secret), await codeOf(owner.secret, -1)]) {
      const refused = await verify(setup.server, again.cookie, { code: stale });
      expect(refused.status).toBe(401);
      expect(apiErrorSchema.parse(refused.json()).code).toBe("MFA_INVALID_CODE");
    }
    expect(await status(setup.server, again.cookie)).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
    // The refused codes did not move the ledger.
    expect(mfaState(setup.instance)?.last_used_step).toBe(consumed);
  });
});

describe("D11.2-AC1 the ledger and the used codes are durable", () => {
  it("a restart forgets nothing: the used step and the used recovery code are still refused", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const code = await codeOf(owner.secret, 1);
    const recoveryCode = owner.codes[4] ?? "";
    expect((await verify(setup.server, (await signIn(setup.server)).cookie, { code })).status).toBe(200);
    expect((await verify(setup.server, (await signIn(setup.server)).cookie, { recoveryCode })).status).toBe(200);
    await stopServer(setup.server);
    const restarted = await serve(setup.instance);
    const login = await signIn(restarted);
    expect((await verify(restarted, login.cookie, { code })).status).toBe(401);
    expect((await verify(restarted, login.cookie, { recoveryCode })).status).toBe(401);
    expect(query(setup.instance, "SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL")).toEqual([{ n: 9 }]);
  });
});

describe("D11.2-AC1 a recovery code at login", () => {
  it("opens the data with the assurance recovery, lowers the rest by one, gives no TOTP time and no trust", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    const typed = (owner.codes[2] ?? "").replace("-", "").toLowerCase();
    const proved = await verify(setup.server, login.cookie, { recoveryCode: typed });
    expect(proved.status).toBe(200);
    expect(mfaVerifiedSchema.parse(proved.json())).toEqual({ nextAction: "ready", remainingRecoveryCodes: 9 });
    // Only the session cookie: a recovery code leaves no trusted device behind.
    expect(proved.cookies).toHaveLength(1);
    expect(proved.cookies[0]?.startsWith(sessionCookieName(setup))).toBe(true);
    expect(count(setup.instance, "trusted_device")).toBe(0);
    expect(sessions(setup).find((row) => row.assurance === "recovery")).toEqual({ assurance: "recovery", totp: null, trusted: null });
    expect(await status(setup.server, login.cookie)).toEqual({ authenticated: false, nextAction: "login" });
    expect(await status(setup.server, proved.cookie)).toEqual({ authenticated: true, nextAction: "ready" });
    expect(query(setup.instance, "SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL")).toEqual([{ n: 9 }]);
    expect(query<{ details: string }>(setup.instance, "SELECT details FROM audit_log WHERE action = 'mfa.recovery_used'")).toEqual([{ details: '{"remainingCodes":9}' }]);
  });

  it("F09 parallel-recovery-use: one code from two sessions: one success, one 401, nine left", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const [first, second] = [await signIn(setup.server), await signIn(setup.server)];
    const recoveryCode = owner.codes[0] ?? "";
    const replies = await Promise.all([verify(setup.server, first.cookie, { recoveryCode }), verify(setup.server, second.cookie, { recoveryCode })]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 401]);
    expect(apiErrorSchema.parse(replies.find((reply) => reply.status === 401)?.json()).code).toBe("MFA_INVALID_CODE");
    expect(query(setup.instance, "SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL")).toEqual([{ n: 9 }]);
    // A used code never works again, from any session.
    expect((await verify(setup.server, (await signIn(setup.server)).cookie, { recoveryCode })).status).toBe(401);
  });

  it("a recovery session cannot step up: it holds no TOTP time, and a code of the TOTP renews it into a TOTP session", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const proved = await verify(setup.server, (await signIn(setup.server)).cookie, { recoveryCode: owner.codes[1] ?? "" });
    expect(sessions(setup).find((row) => row.assurance === "recovery")?.totp).toBeNull();
    // A recovery code is not accepted by the step-up at all.
    const refused = await post(setup.server, "/api/v1/mfa/step-up", { recoveryCode: owner.codes[2] ?? "" }, { cookie: proved.cookie });
    expect(refused.status).toBe(422);
    const stepped = await stepUp(setup.server, proved.cookie, await codeOf(owner.secret, 1));
    expect(stepped.status).toBe(200);
    expect(stepped.cookie).not.toBe(proved.cookie);
    expect(await status(setup.server, proved.cookie)).toEqual({ authenticated: false, nextAction: "login" });
    expect(sessions(setup).find((row) => row.assurance === "totp" && row.totp !== null)).toBeDefined();
    expect(auditActions(setup, "mfa.step_up")).toEqual(["mfa.step_up"]);
  });
});

describe("D11.2-AC1 trusted devices", () => {
  it("remembering the device leaves a cookie; the next password login is trusted without a TOTP, which a step-up still needs", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const proved = await verify(setup.server, (await signIn(setup.server)).cookie, { code: await codeOf(owner.secret, 1), rememberDevice: true });
    expect(proved.status).toBe(200);
    expect(proved.cookies).toHaveLength(2);
    const trustedCookie = proved.cookies.find((cookie) => cookie.startsWith(trustedCookieName(setup))) ?? "";
    const trustedLine = proved.setCookies.find((line) => line.startsWith(trustedCookieName(setup))) ?? "";
    expect(trustedLine).toMatch(/HttpOnly/i);
    expect(trustedLine).toMatch(/SameSite=Lax/i);
    expect(trustedLine).toMatch(/Max-Age=259\d{4}|Max-Age=2592000/);
    const device = query<{ id: string; token_hash: string; created_at_ms: number; expires_at_ms: number; revoked_at_ms: number | null }>(setup.instance, "SELECT * FROM trusted_device");
    expect(device).toHaveLength(1);
    expect(device[0]?.expires_at_ms).toBe((device[0]?.created_at_ms ?? 0) + 30 * 24 * 3600 * 1000);
    // Only the hash is stored: the token of the cookie is not in the table.
    const tokenPart = decodeURIComponent(trustedCookie.split("=")[1] ?? "").split(".")[0] ?? "";
    expect(tokenPart.length).toBeGreaterThan(30);
    expect(JSON.stringify(device)).not.toContain(tokenPart);

    // A later login with the password and that cookie: the data are open without a TOTP.
    const trusted = await signIn(setup.server, trustedCookie);
    expect(trusted.status).toBe(200);
    expect(trusted.json()).toEqual({ authenticated: true, nextAction: "ready" });
    expect(sessions(setup).find((row) => row.assurance === "trusted")).toMatchObject({ totp: null, trusted: device[0]?.id });
    // Without the cookie the same password gets the challenge.
    expect((await signIn(setup.server)).json()).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
    // Trust gives no fresh TOTP: a step-up on the trusted session needs a code.
    expect((await stepUp(setup.server, trusted.cookie, "000000")).status).toBe(401);
    // Half a minute passes (the ledger moves back by the steps that would have gone by) and the next code is fresh.
    execute(setup.instance, "UPDATE mfa_state SET last_used_step = last_used_step - 10");
    const stepped = await stepUp(setup.server, trusted.cookie, await codeOf(owner.secret, 1));
    expect(stepped.status).toBe(200);
    expect(sessions(setup).filter((row) => row.assurance === "trusted")).toHaveLength(0);
  });

  it("a revoked device, an expired one and a foreign token open nothing", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const proved = await verify(setup.server, (await signIn(setup.server)).cookie, { code: await codeOf(owner.secret, 1), rememberDevice: true });
    const trustedCookie = proved.cookies.find((cookie) => cookie.startsWith(trustedCookieName(setup))) ?? "";
    const trusted = await signIn(setup.server, trustedCookie);
    expect(await status(setup.server, trusted.cookie)).toEqual({ authenticated: true, nextAction: "ready" });

    // Revoked while the session lives: the data close at the next request.
    execute(setup.instance, "UPDATE trusted_device SET revoked_at_ms = 1");
    expect(await status(setup.server, trusted.cookie)).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
    expect(sessions(setup).find((row) => row.assurance === "trusted")?.trusted).toBeTruthy();
    // And a new login with that cookie is an ordinary password session.
    expect((await signIn(setup.server, trustedCookie)).json()).toEqual({ authenticated: true, nextAction: "mfa_challenge" });

    // Expired: same.
    execute(setup.instance, "UPDATE trusted_device SET revoked_at_ms = NULL, expires_at_ms = created_at_ms + 1");
    expect(await status(setup.server, trusted.cookie)).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
    expect((await signIn(setup.server, trustedCookie)).json()).toEqual({ authenticated: true, nextAction: "mfa_challenge" });

    // A cookie of another installation's name or a changed signature is not trust.
    execute(setup.instance, "UPDATE trusted_device SET expires_at_ms = created_at_ms + 1000000000000");
    const [name, value = ""] = trustedCookie.split("=");
    for (const forged of [`${name}=${value.slice(0, -2)}xx`, `openlife-000000000000.trusted_device=${value}`, `${name}=${value.split(".")[0]}`]) {
      expect((await signIn(setup.server, forged)).json()).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
    }
    expect((await signIn(setup.server, trustedCookie)).json()).toEqual({ authenticated: true, nextAction: "ready" });
  });

  it("the trust is the owner's choice with a TOTP: the option is refused beside a recovery code", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    const refused = await verify(setup.server, login.cookie, { recoveryCode: owner.codes[0] ?? "", rememberDevice: true });
    expect(refused.status).toBe(422);
    expect(count(setup.instance, "trusted_device")).toBe(0);
    expect(query(setup.instance, "SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL")).toEqual([{ n: 10 }]);
  });

  it("a password reset revokes every trusted device, so the old cookie is only a password login afterwards", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const proved = await verify(setup.server, (await signIn(setup.server)).cookie, { code: await codeOf(owner.secret, 1), rememberDevice: true });
    const trustedCookie = proved.cookies.find((cookie) => cookie.startsWith(trustedCookieName(setup))) ?? "";
    await stopServer(setup.server);
    const reset = await runBuiltScript(RESET_PASSWORD, ["--installation", setup.instance.dir], { PATH: process.env["PATH"] ?? "", ...setup.instance.env }, JSON.stringify({ password: OWNER_PASSWORD }));
    expect(reset.code, reset.output).toBe(0);
    expect(reset.output).toContain('"revokedDevices":1');
    expect(query(setup.instance, "SELECT count(*) AS n FROM trusted_device WHERE revoked_at_ms IS NOT NULL")).toEqual([{ n: 1 }]);
    const restarted = await serve(setup.instance);
    expect((await signIn(restarted, trustedCookie)).json()).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
  });
});

describe("D11.2-AC2 refusals and rollback", () => {
  it("a failing audit spends no step, publishes no session or cookie, and the same code works after repair", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    const code = await codeOf(owner.secret, 1);
    const before = mfaState(setup.instance)?.last_used_step;
    execute(setup.instance, `CREATE TRIGGER fail_verified BEFORE INSERT ON audit_log WHEN new.action = 'mfa.verified' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const failed = await verify(setup.server, login.cookie, { code, rememberDevice: true });
    expect(failed.status).toBe(503);
    expect(failed.cookies).toEqual([]);
    expect(apiErrorSchema.parse(failed.json()).code).toBe("AUTH_UNAVAILABLE");
    expect(failed.text).not.toContain("audit unavailable");
    expect(mfaState(setup.instance)?.last_used_step).toBe(before);
    expect(count(setup.instance, "trusted_device")).toBe(0);
    expect(await status(setup.server, login.cookie)).toEqual({ authenticated: true, nextAction: "mfa_challenge" });

    execute(setup.instance, "DROP TRIGGER fail_verified");
    expect((await verify(setup.server, login.cookie, { code })).status).toBe(200);
  });

  it("a failing audit spends no recovery code and publishes nothing", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    execute(setup.instance, `CREATE TRIGGER fail_recovery BEFORE INSERT ON audit_log WHEN new.action = 'mfa.recovery_used' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const failed = await verify(setup.server, login.cookie, { recoveryCode: owner.codes[0] ?? "" });
    expect(failed.status).toBe(503);
    expect(failed.cookies).toEqual([]);
    expect(query(setup.instance, "SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL")).toEqual([{ n: 10 }]);
    expect(sessions(setup).filter((row) => row.assurance === "recovery")).toHaveLength(0);
    execute(setup.instance, "DROP TRIGGER fail_recovery");
    expect((await verify(setup.server, login.cookie, { recoveryCode: owner.codes[0] ?? "" })).status).toBe(200);
  });

  it("a code that cannot be a recovery code, an unknown one and a wrong TOTP are one refusal, and change nothing", async () => {
    const setup = await installation();
    await readyOwner(setup);
    const login = await signIn(setup.server);
    for (const body of [{ recoveryCode: "not a code" }, { recoveryCode: "ZZZZZ-ZZZZZ" }, { code: "000000" }]) {
      const refused = await verify(setup.server, login.cookie, body);
      expect(refused.status).toBe(401);
      expect(apiErrorSchema.parse(refused.json()).code).toBe("MFA_INVALID_CODE");
    }
    expect(query(setup.instance, "SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL")).toEqual([{ n: 10 }]);
    expect(await status(setup.server, login.cookie)).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
  });

  it("before the enrollment is complete there is nothing to prove: 409; a step-up needs the data first", async () => {
    const setup = await installation();
    // A new owner: no secret yet.
    const fresh = await signIn(setup.server);
    const none = await verify(setup.server, fresh.cookie, { code: "123456" });
    expect(none.status).toBe(409);
    expect(apiErrorSchema.parse(none.json()).code).toBe("ENROLLMENT_CHANGED");
    // Enrolled but not acknowledged: still 409 for a login proof.
    const first = await enrolled(setup);
    const awaiting = await verify(setup.server, first.confirmed.cookie, { code: await codeOf(first.secret, 1) });
    expect(awaiting.status).toBe(409);
    expect(mfaState(setup.instance)?.enrollment_state).toBe("awaiting_recovery_ack");
    // Acknowledged, data not chosen: the step-up says what is missing.
    await post(setup.server, "/api/v1/mfa/enrollment/recovery/ack", { batchId: first.codes?.batchId }, { cookie: first.confirmed.cookie });
    const blocked = await stepUp(setup.server, first.confirmed.cookie, await codeOf(first.secret, 1));
    expect(blocked.status).toBe(403);
    expect(apiErrorSchema.parse(blocked.json()).code).toBe("SETUP_DATA_REQUIRED");
    // A password session cannot step up either: the factor comes first.
    const password = await signIn(setup.server);
    execute(setup.instance, "UPDATE instance_state SET data_choice = 'empty'");
    const needsFactor = await stepUp(setup.server, password.cookie, await codeOf(first.secret, 1));
    expect(needsFactor.status).toBe(403);
    expect(apiErrorSchema.parse(needsFactor.json()).code).toBe("MFA_REQUIRED");
  });

  it("no cookie, a forged cookie, a foreign Origin and a bad body are refused before any factor is read", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    const code = await codeOf(owner.secret, 1);
    expect((await verify(setup.server, null, { code })).status).toBe(401);
    expect((await verify(setup.server, `${login.cookie ?? ""}x`, { code })).status).toBe(401);
    for (const origin of [null, "https://evil.example", "http://localhost:3000"]) {
      expect((await post(setup.server, "/api/v1/mfa/verify", { code }, { cookie: login.cookie, origin })).status).toBe(403);
      expect((await post(setup.server, "/api/v1/mfa/step-up", { code }, { cookie: login.cookie, origin })).status).toBe(403);
    }
    for (const body of [{}, { code, recoveryCode: "AAAAA-AAAAA" }, { code: "12345" }, { code, rememberDevice: "yes" }, { code, assurance: "totp" }, "not json"]) {
      expect((await verify(setup.server, login.cookie, body)).status, JSON.stringify(body)).toBe(422);
    }
    // Nothing above spent the code.
    expect((await verify(setup.server, login.cookie, { code })).status).toBe(200);
  });

  it("the plain recovery codes and trusted tokens are in no log and no database file", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const proved = await verify(setup.server, (await signIn(setup.server)).cookie, { code: await codeOf(owner.secret, 1), rememberDevice: true });
    await verify(setup.server, (await signIn(setup.server)).cookie, { recoveryCode: owner.codes[0] ?? "" });
    const trustedCookie = proved.cookies.find((cookie) => cookie.startsWith(trustedCookieName(setup))) ?? "";
    const token = decodeURIComponent(trustedCookie.split("=")[1] ?? "").split(".")[0] ?? "";
    const writer = openDatabase(path.join(setup.instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.pragma("wal_checkpoint(TRUNCATE)");
    writer.close();
    const files = [readFileSync(path.join(setup.instance.dir, "data", "app.db")).toString("latin1"), setup.server.output(), readFileSync(path.join(setup.instance.dir, "data", "logs", "app", "app.jsonl"), "utf8")];
    for (const text of files) {
      expect(text).not.toContain(token);
      for (const code of owner.codes) {
        expect(text).not.toContain(code);
        expect(text).not.toContain(code.replace("-", ""));
      }
    }
  });
});
