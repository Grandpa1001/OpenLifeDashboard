// D43.3 — changing the password from a live session over HTTP, on the in-process app of the harness
// (Scope §5.9; Architektura §9.6, §9.8; DEV §9.40).
// AC1: no session is 401 and a foreign Origin 403; a new password outside the contract is 422 and changes
//      nothing; a session admitted by a recovery code is refused STEP_UP_REQUIRED; a wrong current password
//      is told at its field (INVALID_CREDENTIALS), changes nothing, and counts in the same buckets as a
//      wrong password at sign-in, so the fifth is a lock that holds for the right password too.
// AC2: with a fresh TOTP and the right current password the new password works and the old one does not;
//      the caller keeps working in a session that replaces its own (the old cookie is dead, the browser is
//      kept); every other session ends and every trusted device is revoked; the change is audited with
//      counts and the log and the audit hold no password.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { passwordChangedSchema, SECURITY_DEVICES_PATH, SECURITY_PASSWORD_PATH, SECURITY_SESSIONS_PATH, securitySessionListSchema, trustedDeviceListSchema } from "@openlife/contracts/http/security";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

const NEW_PASSWORD = "A brand new passphrase 2026";
const BROWSER_A = "Browser A on macOS";

/** The owner with a fresh TOTP session A, a trusted device with its session T, and a session B admitted by a recovery code. */
async function owner() {
  const h = await createAppHarness();
  const signIn = (password: string, agent: string, cookie: string | null = null) => h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password }, { cookie, headers: { "User-Agent": agent } });
  const first = (await signIn(HARNESS_PASSWORD, BROWSER_A)).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: first })).json() as { challengeId: string; otpauthUri: string };
  const secret = secretOf(begun.otpauthUri);
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secret) }, { cookie: first });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  const proved = await h.request("POST", "/api/v1/mfa/verify", { code: await codeOf(secret, 1), rememberDevice: true }, { cookie: (await signIn(HARNESS_PASSWORD, "Browser P")).cookie });
  const trustedCookie = proved.setCookies.map((line) => line.split(";")[0] ?? "").find((cookie) => cookie.includes("trusted_device")) ?? "";
  const t = (await signIn(HARNESS_PASSWORD, "Browser T", trustedCookie)).cookie ?? "";
  const b = (await h.request("POST", "/api/v1/mfa/verify", { recoveryCode: issued.recoveryCodes[0] }, { cookie: (await signIn(HARNESS_PASSWORD, "Browser B")).cookie })).cookie ?? "";
  const change = (cookie: string | null, body: unknown, origin?: string | null) => h.request("POST", SECURITY_PASSWORD_PATH, body, { cookie, ...(origin === undefined ? {} : { origin }) });
  const canSignIn = async (password: string) => (await signIn(password, "Browser Z")).status === 200;
  return { h, a, b, t, change, canSignIn, signIn, trustedCookie };
}

const request = (currentPassword: string, newPassword = NEW_PASSWORD) => ({ currentPassword, newPassword });

describe("D43.3-AC1 the refusals change nothing", () => {
  it("answers 401 without a session, 403 for a foreign Origin, and 422 for a new password outside the contract", async () => {
    const { a, change, canSignIn } = await owner();
    const anonymous = await change(null, request(HARNESS_PASSWORD));
    expect(anonymous.status).toBe(401);
    expect(apiErrorSchema.parse(anonymous.json()).requestId).toBeTruthy();
    expect((await change(a, request(HARNESS_PASSWORD), "https://evil.example")).status).toBe(403);
    for (const body of [request(HARNESS_PASSWORD, "too short"), request(HARNESS_PASSWORD, "x".repeat(129)), { currentPassword: HARNESS_PASSWORD }, { ...request(HARNESS_PASSWORD), extra: 1 }, request("")]) {
      expect((await change(a, body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect(await canSignIn(HARNESS_PASSWORD)).toBe(true);
  });

  it("refuses a session admitted by a recovery code with STEP_UP_REQUIRED and changes nothing", async () => {
    const { b, change, canSignIn } = await owner();
    const refused = await change(b, request(HARNESS_PASSWORD));
    expect(refused.status).toBe(403);
    expect(apiErrorSchema.parse(refused.json()).code).toBe("STEP_UP_REQUIRED");
    expect(await canSignIn(HARNESS_PASSWORD)).toBe(true);
    expect(await canSignIn(NEW_PASSWORD)).toBe(false);
  });

  it("tells a wrong current password at its field, changes nothing, and counts it with the wrong passwords of sign-in until a lock", async () => {
    const { h, a, change, canSignIn } = await owner();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await change(a, request("not the password"));
      expect(wrong.status, `attempt ${attempt}`).toBe(403);
      expect(apiErrorSchema.parse(wrong.json()).code).toBe("INVALID_CREDENTIALS");
    }
    const locked = await change(a, request("not the password"));
    expect(locked.status).toBe(429);
    expect(apiErrorSchema.parse(locked.json()).code).toBe("AUTH_LOCKED");
    // The lock is the one of the password: the right password is refused too, at sign-in and here.
    expect((await change(a, request(HARNESS_PASSWORD))).status).toBe(429);
    expect(await canSignIn(HARNESS_PASSWORD)).toBe(false);
    expect(h.rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'password.change_failed'")).toHaveLength(5);
    expect(h.rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'owner.password_changed'")).toHaveLength(0);
  });
});

describe("D43.3-AC2 the change", () => {
  it("makes the new password work and the old one not, keeps the caller in a session that replaces its own, and ends the others and the trusted devices", async () => {
    const { h, a, b, t, change, canSignIn, trustedCookie } = await owner();
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: t })).status).toBe(200);
    const done = await change(a, request(HARNESS_PASSWORD));
    expect(done.status).toBe(200);
    const { revokedSessions, revokedDevices } = passwordChangedSchema.parse(done.json());
    expect(revokedSessions).toBeGreaterThanOrEqual(2);
    expect(revokedDevices).toBe(1);

    expect(await canSignIn(NEW_PASSWORD)).toBe(true);
    expect(await canSignIn(HARNESS_PASSWORD)).toBe(false);

    // The caller's old cookie is dead; the cookie of the change opens the data in its place, with its browser kept.
    const replacement = done.cookie ?? "";
    expect(replacement).not.toBe("");
    expect(replacement).not.toBe(a);
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: a })).status).toBe(401);
    const sessions = securitySessionListSchema.parse((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: replacement })).json()).sessions;
    const own = sessions.find((session) => session.current);
    expect(own?.userAgent).toBe(BROWSER_A);
    expect(own?.assurance).toBe("totp");
    // Every other session is gone, and so is the trust: a sign-in with the device cookie is an ordinary password session.
    for (const cookie of [b, t]) expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie })).status).toBe(401);
    expect(trustedDeviceListSchema.parse((await h.request("GET", SECURITY_DEVICES_PATH, undefined, { cookie: replacement })).json()).devices).toEqual([]);
    const again = await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: NEW_PASSWORD }, { cookie: trustedCookie });
    expect(again.json()).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
  });

  it("audits the change with counts and keeps every password out of the audit and the log", async () => {
    const { h, a, change } = await owner();
    expect((await change(a, request(HARNESS_PASSWORD))).status).toBe(200);
    const audit = h.rows<{ action: string; details: string }>("SELECT action, details FROM audit_log WHERE action = 'owner.password_changed'");
    expect(audit).toHaveLength(1);
    const details = JSON.parse(audit[0]?.details ?? "{}") as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(["accessEpoch", "revokedDevices", "revokedSessions"]);
    const everything = JSON.stringify(h.rows("SELECT * FROM audit_log")) + h.logLines().join("\n");
    for (const secret of [HARNESS_PASSWORD, NEW_PASSWORD]) expect(everything).not.toContain(secret);
  });
});
