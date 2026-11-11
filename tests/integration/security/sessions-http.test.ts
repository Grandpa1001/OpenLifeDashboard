// D43.1 — the sessions of the owner over HTTP, on the in-process app of the harness (Scope §5.9;
// Architektura §9.6, §9.7; DEV §9.40): the list, the end of one other session and the end of all the
// others with a fresh second factor.
// AC1: no session is 401 and a foreign Origin 403; the list names each session by its id with the
//      browser and the address it was opened from (kept through the proofs), marks the caller's own, has
//      the newest first and carries no token; the caller's own session and an unknown id are not found;
//      another session ends at once and its cookie authenticates nothing.
// AC2: ending all the others needs a fresh TOTP: a session admitted by a recovery code is refused with
//      STEP_UP_REQUIRED and nothing is ended; a session with a fresh TOTP ends every other one and keeps
//      its own; every end is audited with the id and the count and never with a token.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { issuedRecoveryCodesSchema, MFA_STEP_UP_PATH } from "@openlife/contracts/http/mfa";
import { SECURITY_SESSIONS_PATH, SECURITY_SESSIONS_REVOKE_OTHERS_PATH, securitySessionListSchema, securitySessionPath, sessionsRevokedSchema } from "@openlife/contracts/http/security";
import { afterEach, describe, expect, it } from "vitest";
import { createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { closeHarnesses } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

const BROWSER_B = "Browser B on Linux";
const BROWSER_C = "Browser C on iOS";

/** The owner with a TOTP session A and two sessions B and C admitted by recovery codes (the TOTP steps of the window stay free for a step-up). */
async function threeSessions() {
  const h = await createAppHarness();
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD }, { headers: { "User-Agent": "Browser A on macOS" } })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const secret = secretOf(begun.otpauthUri);
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secret) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });

  const signIn = async (agent: string) => (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD }, { headers: { "User-Agent": agent } })).cookie ?? "";
  const b = (await h.request("POST", "/api/v1/mfa/verify", { recoveryCode: issued.recoveryCodes[0] }, { cookie: await signIn(BROWSER_B) })).cookie ?? "";
  const c = (await h.request("POST", "/api/v1/mfa/verify", { recoveryCode: issued.recoveryCodes[1] }, { cookie: await signIn(BROWSER_C) })).cookie ?? "";
  const list = async (cookie: string) => securitySessionListSchema.parse((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie })).json()).sessions;
  return { h, secret, a, b, c, list };
}

describe("D43.1-AC1 the list and the end of one session", () => {
  it("answers 401 without a session and 403 for a foreign Origin on each route", async () => {
    const { h, a } = await threeSessions();
    for (const [method, route, body] of [["GET", SECURITY_SESSIONS_PATH, undefined], ["POST", SECURITY_SESSIONS_REVOKE_OTHERS_PATH, {}], ["DELETE", securitySessionPath("any"), {}]] as const) {
      const anonymous = await h.request(method, route, body, { cookie: null });
      expect(anonymous.status, `${method} ${route}`).toBe(401);
      expect(apiErrorSchema.parse(anonymous.json()).requestId).toBeTruthy();
      if (method !== "GET") expect((await h.request(method, route, body, { cookie: a, origin: "https://evil.example" })).status, `${method} ${route} foreign Origin`).toBe(403);
    }
  });

  it("lists the sessions newest first with their browsers kept through the proofs, marks the caller and carries no token", async () => {
    const { h, a, b, c, list } = await threeSessions();
    const seen = await list(a);
    expect(seen.map((session) => session.userAgent)).toEqual([BROWSER_C, BROWSER_B, "Browser A on macOS"]);
    expect(seen.map((session) => session.assurance)).toEqual(["recovery", "recovery", "totp"]);
    expect(seen.map((session) => session.current)).toEqual([false, false, true]);
    expect(new Set(seen.map((session) => session.id)).size).toBe(3);
    for (const session of seen) {
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.parse(session.createdAt));
      expect(Date.parse(session.lastProofAt)).toBeGreaterThanOrEqual(Date.parse(session.createdAt) - 1000);
    }
    // The caller is marked by who asks: from C the current one is C's.
    expect((await list(c)).map((session) => session.current)).toEqual([true, false, false]);
    // No token of any session, and no cookie value, is in the answer.
    const raw = (await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: a })).text;
    for (const cookie of [a, b, c]) {
      const token = await h.sessionToken(cookie);
      expect(token).not.toBeNull();
      expect(raw).not.toContain(token ?? "");
    }
  });

  it("does not find the caller's own session or an unknown id, and ends another session at once", async () => {
    const { h, a, b, list } = await threeSessions();
    const seen = await list(a);
    const own = seen.find((session) => session.current)?.id ?? "";
    const other = seen.find((session) => session.userAgent === BROWSER_B)?.id ?? "";
    expect((await h.request("DELETE", securitySessionPath(own), {}, { cookie: a })).status).toBe(404);
    expect((await h.request("DELETE", securitySessionPath("no-such-session"), {}, { cookie: a })).status).toBe(404);
    expect((await list(a)).length).toBe(3);

    const ended = await h.request("DELETE", securitySessionPath(other), {}, { cookie: a });
    expect(ended.status).toBe(204);
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: b })).status).toBe(401);
    expect((await list(a)).map((session) => session.userAgent)).toEqual([BROWSER_C, "Browser A on macOS"]);
    // Ending it again finds nothing.
    expect((await h.request("DELETE", securitySessionPath(other), {}, { cookie: a })).status).toBe(404);
  });
});

describe("D43.1-AC2 ending all the others needs a fresh second factor", () => {
  it("refuses a session admitted by a recovery code with STEP_UP_REQUIRED and ends nothing, until a TOTP step-up", async () => {
    const { h, secret, b, list } = await threeSessions();
    const refused = await h.request("POST", SECURITY_SESSIONS_REVOKE_OTHERS_PATH, {}, { cookie: b });
    expect(refused.status).toBe(403);
    expect(apiErrorSchema.parse(refused.json()).code).toBe("STEP_UP_REQUIRED");
    expect((await list(b)).length).toBe(3);

    // The step-up proves a TOTP, replaces the session and the retry then passes.
    const stepped = await h.request("POST", MFA_STEP_UP_PATH, { code: await codeOf(secret, 1) }, { cookie: b });
    expect(stepped.status).toBe(200);
    const fresh = stepped.cookie ?? "";
    const done = await h.request("POST", SECURITY_SESSIONS_REVOKE_OTHERS_PATH, {}, { cookie: fresh });
    expect(done.status).toBe(200);
    expect(sessionsRevokedSchema.parse(done.json())).toEqual({ revoked: 2 });
    const left = await list(fresh);
    expect(left).toHaveLength(1);
    expect(left[0]?.current).toBe(true);
    // The browser of the session survived its step-up.
    expect(left[0]?.userAgent).toBe(BROWSER_B);
  });

  it("ends every other session with a fresh TOTP, keeps the caller's own, and audits the ends without a token", async () => {
    const { h, a, b, c, list } = await threeSessions();
    const other = (await list(a)).find((session) => session.userAgent === BROWSER_B)?.id ?? "";
    expect((await h.request("DELETE", securitySessionPath(other), {}, { cookie: a })).status).toBe(204);
    const done = await h.request("POST", SECURITY_SESSIONS_REVOKE_OTHERS_PATH, {}, { cookie: a });
    expect(done.status).toBe(200);
    expect(sessionsRevokedSchema.parse(done.json())).toEqual({ revoked: 1 });
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: c })).status).toBe(401);
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: b })).status).toBe(401);
    expect((await list(a)).map((session) => session.current)).toEqual([true]);
    // Nothing left to end: the count is zero and the answer still succeeds.
    expect(sessionsRevokedSchema.parse((await h.request("POST", SECURITY_SESSIONS_REVOKE_OTHERS_PATH, {}, { cookie: a })).json())).toEqual({ revoked: 0 });

    const audit = h.rows<{ action: string; entity_id: string; details: string }>("SELECT action, entity_id, details FROM audit_log WHERE action LIKE 'session.%' ORDER BY id");
    expect(audit.map((row) => row.action)).toEqual(["session.revoked", "session.revoked_others", "session.revoked_others"]);
    expect(audit[0]?.entity_id).toBe(other);
    expect(JSON.parse(audit[1]?.details ?? "{}")).toEqual({ revoked: 1 });
    for (const cookie of [a, b, c]) expect(JSON.stringify(audit)).not.toContain((await h.sessionToken(cookie)) ?? "x");
  });
});
