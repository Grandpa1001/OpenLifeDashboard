// D43.5 — setting the second factor up again and turning it off, over HTTP, on the in-process app of the
// harness (Scope §5.9; Architektura §9.6; DEV §9.40).
// AC1: no session is 401 and a foreign Origin 403; turning off needs the explicit acknowledgment (422
//      without it); a session admitted by a recovery code is refused STEP_UP_REQUIRED by both routes; a
//      restart with a fresh TOTP kills the old secret and the old codes, ends the other sessions and the
//      trusted devices, keeps the caller on to an enrollment, and is audited.
// AC2: turning off with a fresh TOTP leaves the password as the factor (a sign-in with the password alone
//      opens the data), removes the secret and the codes, ends the other sessions and devices; a step-up is
//      then a fresh password, which the confirmation route gives (a wrong one is told at its field and
//      counts); turning off twice is refused; a restart from the off state turns the factor on again.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import {
  factorChangedSchema,
  factorRestartedSchema,
  SECURITY_DEVICES_PATH,
  SECURITY_MFA_DISABLE_PATH,
  SECURITY_MFA_RESTART_PATH,
  SECURITY_PASSWORD_CONFIRM_PATH,
  SECURITY_SESSIONS_PATH,
  SECURITY_SESSIONS_REVOKE_OTHERS_PATH,
  trustedDeviceListSchema,
} from "@openlife/contracts/http/security";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

/** The owner with a fresh TOTP session A, a trusted device with its session T, and a session B admitted by a recovery code. */
async function owner() {
  const h = await createAppHarness();
  const signIn = (password = HARNESS_PASSWORD, cookie: string | null = null) => h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password }, { cookie });
  const first = (await signIn()).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: first })).json() as { challengeId: string; otpauthUri: string };
  const secret = secretOf(begun.otpauthUri);
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secret) }, { cookie: first });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  const proved = await h.request("POST", "/api/v1/mfa/verify", { code: await codeOf(secret, 1), rememberDevice: true }, { cookie: (await signIn()).cookie });
  const trustedCookie = proved.setCookies.map((line) => line.split(";")[0] ?? "").find((cookie) => cookie.includes("trusted_device")) ?? "";
  const t = (await signIn(HARNESS_PASSWORD, trustedCookie)).cookie ?? "";
  const b = (await h.request("POST", "/api/v1/mfa/verify", { recoveryCode: issued.recoveryCodes[0] }, { cookie: (await signIn()).cookie })).cookie ?? "";
  const post = (route: string, cookie: string | null, body: unknown = {}, origin?: string | null) => h.request("POST", route, body, { cookie, ...(origin === undefined ? {} : { origin }) });
  const status = async (cookie: string) => (await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie })).status;
  const policy = () => h.rows<{ policy: string; enrollment_state: string; secret_generation: number; active_secret: string | null }>("SELECT policy, enrollment_state, secret_generation, active_secret FROM mfa_state")[0];
  return { h, a, b, t, secret, issued, post, status, policy, signIn };
}

const DISABLE = { acknowledgeRisk: true };

describe("D43.5-AC1 setting the factor up again", () => {
  it("answers 401 without a session and 403 for a foreign Origin, and turning off needs the acknowledgment of the risk", async () => {
    const { h, a, post, policy } = await owner();
    for (const [route, body] of [[SECURITY_MFA_RESTART_PATH, {}], [SECURITY_MFA_DISABLE_PATH, DISABLE], [SECURITY_PASSWORD_CONFIRM_PATH, { password: HARNESS_PASSWORD }]] as const) {
      const anonymous = await post(route, null, body);
      expect(anonymous.status, route).toBe(401);
      expect(apiErrorSchema.parse(anonymous.json()).requestId).toBeTruthy();
      expect((await post(route, a, body, "https://evil.example")).status, `${route} foreign Origin`).toBe(403);
    }
    for (const body of [{}, { acknowledgeRisk: false }, { acknowledgeRisk: "yes" }, { acknowledgeRisk: true, extra: 1 }]) {
      expect((await post(SECURITY_MFA_DISABLE_PATH, a, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await post(SECURITY_PASSWORD_CONFIRM_PATH, a, {})).status).toBe(422);
    expect(policy()).toMatchObject({ policy: "required", enrollment_state: "complete" });
    expect(h.rows("SELECT action FROM audit_log WHERE action IN ('mfa.restarted', 'mfa.disabled')")).toEqual([]);
  });

  it("refuses a session admitted by a recovery code on both routes and changes nothing", async () => {
    const { b, post, policy } = await owner();
    for (const [route, body] of [[SECURITY_MFA_RESTART_PATH, {}], [SECURITY_MFA_DISABLE_PATH, DISABLE]] as const) {
      const refused = await post(route, b, body);
      expect([route, refused.status, apiErrorSchema.parse(refused.json()).code]).toEqual([route, 403, "STEP_UP_REQUIRED"]);
    }
    expect(policy()).toMatchObject({ policy: "required", enrollment_state: "complete", secret_generation: 1 });
  });

  it("restarts with a fresh TOTP: the old secret and codes die, the others end, the caller enrolls again in its own session, and it is audited", async () => {
    const { h, a, b, t, secret, issued, post, status, policy, signIn } = await owner();
    const restarted = await post(SECURITY_MFA_RESTART_PATH, a);
    expect(restarted.status).toBe(200);
    const body = factorRestartedSchema.parse(restarted.json());
    expect(body.nextAction).toBe("mfa_enrollment");
    expect(body.revokedSessions).toBeGreaterThanOrEqual(2);
    expect(body.revokedDevices).toBe(1);
    expect(policy()).toMatchObject({ policy: "reset_required", enrollment_state: "required", secret_generation: 0, active_secret: null });

    // The caller's old cookie and every other session are dead; the new cookie is a session without a factor.
    const mine = restarted.cookie ?? "";
    expect(mine).not.toBe("");
    for (const cookie of [a, b, t]) expect(await status(cookie), cookie.slice(0, 20)).toBe(401);
    expect(await status(mine)).toBe(403);

    // Enrolling again from that very session: a new secret, new codes, the data open.
    const begun = (await post("/api/v1/mfa/enrollment/begin", mine)).json() as { challengeId: string; otpauthUri: string };
    const next = secretOf(begun.otpauthUri);
    expect(next.equals(secret)).toBe(false);
    const confirmed = await post("/api/v1/mfa/enrollment/confirm", mine, { challengeId: begun.challengeId, code: await codeOf(next) });
    expect(confirmed.status).toBe(200);
    const fresh = issuedRecoveryCodesSchema.parse(confirmed.json());
    const again = confirmed.cookie ?? "";
    expect((await post("/api/v1/mfa/enrollment/recovery/ack", again, { batchId: fresh.batchId })).status).toBe(200);
    expect(await status(again)).toBe(200);
    expect(policy()).toMatchObject({ policy: "required", enrollment_state: "complete", secret_generation: 1 });
    expect(trustedDeviceListSchema.parse((await h.request("GET", SECURITY_DEVICES_PATH, undefined, { cookie: again })).json()).devices).toEqual([]);

    // The old recovery codes are dead and the old authenticator no longer proves anything.
    expect((await post("/api/v1/mfa/verify", (await signIn()).cookie, { recoveryCode: issued.recoveryCodes[2] })).status).toBe(401);
    expect((await post("/api/v1/mfa/verify", (await signIn()).cookie, { code: await codeOf(secret, 1) })).status).toBe(401);
    expect((await post("/api/v1/mfa/verify", (await signIn()).cookie, { recoveryCode: fresh.recoveryCodes[0] })).status).toBe(200);
    expect(h.rows<{ details: string }>("SELECT details FROM audit_log WHERE action = 'mfa.restarted'")).toHaveLength(1);
  });
});

describe("D43.5-AC2 turning the factor off", () => {
  it("leaves the password as the factor: the secret and codes are gone, the others and the devices end, a sign-in with the password alone opens the data", async () => {
    const { h, a, b, t, post, status, policy, signIn } = await owner();
    const done = await post(SECURITY_MFA_DISABLE_PATH, a, DISABLE);
    expect(done.status).toBe(200);
    expect(factorChangedSchema.parse(done.json()).revokedDevices).toBe(1);
    expect(policy()).toMatchObject({ policy: "disabled", secret_generation: 0, active_secret: null });
    expect(h.rows("SELECT * FROM recovery_code")).toEqual([]);
    expect(await status(a)).toBe(200);
    for (const cookie of [b, t]) expect(await status(cookie)).toBe(401);
    expect(trustedDeviceListSchema.parse((await h.request("GET", SECURITY_DEVICES_PATH, undefined, { cookie: a })).json()).devices).toEqual([]);

    const login = await signIn();
    expect(login.json()).toEqual({ authenticated: true, nextAction: "ready" });
    expect(await status(login.cookie ?? "")).toBe(200);
    // Nothing is left to turn off.
    const twice = await post(SECURITY_MFA_DISABLE_PATH, a, DISABLE);
    expect([twice.status, apiErrorSchema.parse(twice.json()).code]).toEqual([409, "ENROLLMENT_CHANGED"]);
    expect(h.rows<{ details: string }>("SELECT details FROM audit_log WHERE action = 'mfa.disabled'")).toHaveLength(1);
  });

  it("asks for a fresh password as the step-up once the factor is off, and the confirmation gives it; a wrong one is told at its field and counts", async () => {
    const { h, a, post } = await owner();
    // With the factor in force the password proves nothing a step-up takes.
    const early = await post(SECURITY_PASSWORD_CONFIRM_PATH, a, { password: HARNESS_PASSWORD });
    expect([early.status, apiErrorSchema.parse(early.json()).code]).toEqual([409, "ENROLLMENT_CHANGED"]);

    expect((await post(SECURITY_MFA_DISABLE_PATH, a, DISABLE)).status).toBe(200);
    // The password was proved ten minutes ago: a sensitive action is refused.
    h.sql("UPDATE session_ext SET password_verified_at_ms = password_verified_at_ms - 600000");
    const stale = await post(SECURITY_SESSIONS_REVOKE_OTHERS_PATH, a);
    expect([stale.status, apiErrorSchema.parse(stale.json()).code]).toEqual([403, "STEP_UP_REQUIRED"]);

    const wrong = await post(SECURITY_PASSWORD_CONFIRM_PATH, a, { password: "not the password" });
    expect([wrong.status, apiErrorSchema.parse(wrong.json()).code]).toEqual([403, "INVALID_CREDENTIALS"]);
    expect((await post(SECURITY_SESSIONS_REVOKE_OTHERS_PATH, a)).status).toBe(403);

    const confirmed = await post(SECURITY_PASSWORD_CONFIRM_PATH, a, { password: HARNESS_PASSWORD });
    expect(confirmed.status).toBe(204);
    const fresh = confirmed.cookie ?? "";
    expect(fresh).not.toBe(a);
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: a })).status).toBe(401);
    expect((await post(SECURITY_SESSIONS_REVOKE_OTHERS_PATH, fresh)).status).toBe(200);
    expect(h.rows<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'password.confirm%' ORDER BY id").map((row) => row.action)).toEqual(["password.confirm_failed", "password.confirmed"]);
    expect(JSON.stringify(h.rows("SELECT * FROM audit_log")) + h.logLines().join("\n")).not.toContain(HARNESS_PASSWORD);
  });

  it("turns the factor on again by a restart from the off state, which needs the fresh password and ends in an enrollment", async () => {
    const { a, post, status, policy } = await owner();
    expect((await post(SECURITY_MFA_DISABLE_PATH, a, DISABLE)).status).toBe(200);
    const restarted = await post(SECURITY_MFA_RESTART_PATH, a);
    expect(restarted.status).toBe(200);
    expect(policy()).toMatchObject({ policy: "reset_required", enrollment_state: "required" });
    const mine = restarted.cookie ?? "";
    const begun = (await post("/api/v1/mfa/enrollment/begin", mine)).json() as { challengeId: string; otpauthUri: string };
    const confirmed = await post("/api/v1/mfa/enrollment/confirm", mine, { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) });
    expect(confirmed.status).toBe(200);
    const batch = issuedRecoveryCodesSchema.parse(confirmed.json()).batchId;
    expect((await post("/api/v1/mfa/enrollment/recovery/ack", confirmed.cookie ?? "", { batchId: batch })).status).toBe(200);
    expect(policy()).toMatchObject({ policy: "required", enrollment_state: "complete" });
    expect(await status(confirmed.cookie ?? "")).toBe(200);
  });
});
