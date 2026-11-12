// D43.4 — regenerating the recovery codes over HTTP, on the in-process app of the harness (Scope §5.9;
// Architektura §9.6, §9.7; DEV §9.40).
// AC1: no session is 401 and a foreign Origin 403; a session admitted by a recovery code is refused
//      STEP_UP_REQUIRED and its codes keep working; with the second factor off there are no codes to make.
// AC2: with a fresh TOTP a new batch of ten codes is shown once and every old code stops working at once;
//      the data wait for the acknowledgment of the new batch, which opens them again; then the new codes work,
//      only their hashes are stored, and the audit holds no code.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { SECURITY_RECOVERY_CODES_PATH, SECURITY_SESSIONS_PATH } from "@openlife/contracts/http/security";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

/** The owner with a fresh TOTP session A, a session B admitted by a recovery code, and the first batch of codes. */
async function owner() {
  const h = await createAppHarness();
  const signIn = (agent = "Browser") => h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD }, { headers: { "User-Agent": agent } });
  const first = (await signIn()).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: first })).json() as { challengeId: string; otpauthUri: string };
  const secret = secretOf(begun.otpauthUri);
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secret) }, { cookie: first });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  const withCode = async (code: string) => h.request("POST", "/api/v1/mfa/verify", { recoveryCode: code }, { cookie: (await signIn()).cookie });
  const b = (await withCode(issued.recoveryCodes[0] ?? "")).cookie ?? "";
  const regenerate = (cookie: string | null, origin?: string | null) => h.request("POST", SECURITY_RECOVERY_CODES_PATH, {}, { cookie, ...(origin === undefined ? {} : { origin }) });
  const reachesData = async (cookie: string) => (await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie })).status;
  return { h, a, b, issued, regenerate, withCode, reachesData };
}

describe("D43.4-AC1 the refusals", () => {
  it("answers 401 without a session and 403 for a foreign Origin", async () => {
    const { a, regenerate } = await owner();
    const anonymous = await regenerate(null);
    expect(anonymous.status).toBe(401);
    expect(apiErrorSchema.parse(anonymous.json()).requestId).toBeTruthy();
    expect((await regenerate(a, "https://evil.example")).status).toBe(403);
  });

  it("refuses a session admitted by a recovery code with STEP_UP_REQUIRED and leaves the codes as they were", async () => {
    const { h, b, issued, regenerate, withCode } = await owner();
    const refused = await regenerate(b);
    expect(refused.status).toBe(403);
    expect(apiErrorSchema.parse(refused.json()).code).toBe("STEP_UP_REQUIRED");
    expect(h.rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'mfa.recovery_regenerated'")).toHaveLength(0);
    // The second code of the first batch still works.
    expect((await withCode(issued.recoveryCodes[1] ?? "")).status).toBe(200);
  });

  it("makes no codes when the second factor is off", async () => {
    const { h, a, regenerate } = await owner();
    h.sql("UPDATE mfa_state SET policy = 'disabled'");
    const refused = await regenerate(a);
    expect([refused.status, apiErrorSchema.parse(refused.json()).code]).toEqual([409, "ENROLLMENT_CHANGED"]);
  });
});

describe("D43.4-AC2 the new batch", () => {
  it("shows ten new codes once, kills the old ones, holds the data until the new batch is acknowledged, and the new codes work", async () => {
    const { h, a, issued, regenerate, withCode, reachesData } = await owner();
    expect(await reachesData(a)).toBe(200);
    const made = await regenerate(a);
    expect(made.status).toBe(200);
    const fresh = issuedRecoveryCodesSchema.parse(made.json());
    expect(fresh.nextAction).toBe("recovery_ack");
    expect(fresh.batchId).not.toBe(issued.batchId);
    expect(new Set(fresh.recoveryCodes).size).toBe(10);
    expect(fresh.recoveryCodes.some((code) => issued.recoveryCodes.includes(code))).toBe(false);

    // The data wait for the acknowledgment of the batch just shown, and no code signs in meanwhile.
    expect(await reachesData(a)).toBe(403);
    expect((await withCode(fresh.recoveryCodes[0] ?? "")).status).toBe(409);
    const stale = await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
    expect([stale.status, apiErrorSchema.parse(stale.json()).code]).toEqual([409, "RECOVERY_BATCH_CHANGED"]);
    expect((await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: fresh.batchId }, { cookie: a })).status).toBe(200);
    expect(await reachesData(a)).toBe(200);
    // Every old code is dead, the new ones work.
    for (const old of issued.recoveryCodes.slice(1, 4)) expect((await withCode(old)).status, old).toBe(401);
    expect((await withCode(fresh.recoveryCodes[0] ?? "")).status).toBe(200);

    // Only hashes are stored and the audit names the batch, not a code.
    const stored = JSON.stringify(h.rows("SELECT * FROM recovery_code"));
    const trail = JSON.stringify(h.rows("SELECT * FROM audit_log")) + h.logLines().join("\n");
    for (const code of fresh.recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(trail).not.toContain(code);
    }
    expect(h.rows<{ entity_id: string }>("SELECT entity_id FROM audit_log WHERE action = 'mfa.recovery_regenerated'")).toEqual([{ entity_id: fresh.batchId }]);
  });
});
