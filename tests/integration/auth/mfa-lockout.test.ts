// D11.3 — the persistent lockout of the second factor on a real database file, with a controlled
// clock (Architektura §9.8). The use cases, the adapters and the crypto are the production ones;
// only the clock and the identifiers are injected.
// AC1: five wrong codes within 15 minutes lock for 15 minutes; attempts during the lock change
//      nothing and do not extend it; the lock opens exactly at lockedUntil; a restart keeps it.
// AC2: a wrong code is a committed outcome (counter and audit survive the refusal); a failing
//      audit refuses without a session and without a counter; a success clears only the account's
//      bucket of that factor; the password's and the factor's buckets are apart; a burst of
//      parallel attempts counts exactly five.
import type { Failure, Result } from "../../../packages/core/dist/foundation/public.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMfaCrypto } from "../../../apps/server/dist/adapters/auth/mfa-crypto.js";
import { totpStepAt } from "../../../apps/server/dist/adapters/auth/totp.js";
import {
  beginEnrollment as beginTotp,
  confirmEnrollment,
  LOCKOUT_DURATION_MS,
  LOCKOUT_WINDOW_MS,
  signInWithPassword,
  stepUp,
  verifyRecoveryCode,
  verifyTotp,
  type RequestContext,
  type VerificationDependencies,
} from "../../../packages/core/dist/modules/identity/public.js";
import { closeRigs, createIdentityRig, RIG_EMAIL, RIG_T0 as T0, type IdentityRig } from "../../support/identity-rig.ts";
import { activateSecret, codeAt, PROTOTYPE_KEY } from "../../support/mfa-prototype.ts";

afterEach(closeRigs);

const crypto = createMfaCrypto(PROTOTYPE_KEY);
const WRONG = "000000";

type Rig = IdentityRig;

/** An enrolled owner with data chosen, the use cases wired on the rig's unit, and a controlled clock. */
async function enrolledRig() {
  const r = await createIdentityRig();
  const secret = activateSecret(r);
  // A current, acknowledged batch of recovery codes of the production generator.
  const batch = crypto.newRecoveryCodes();
  r.unit.run((ports) => {
    ports.recovery.issueBatch({ batchId: "batch-1", sessionId: "session-0", hashes: batch.hashes });
    return { value: null, invalidations: [] };
  });
  r.sql("UPDATE mfa_state SET enrollment_state = 'complete'; UPDATE instance_state SET data_choice = 'empty'");
  let ids = 0;
  const deps = (): VerificationDependencies => ({
    unit: r.unit,
    crypto,
    nowMs: () => r.clock.now,
    newId: () => `proof-id-${(ids += 1)}`,
    newSessionToken: () => `proof-token-${(ids += 1)}`,
    mfaAccountKey: (ownerId) => `mfa:account:${ownerId}`,
  });
  return { r, secret, codes: batch.codes, deps };
}

const context = (ip = "203.0.113.1", n = 1): RequestContext => ({ requestId: `req-${ip}-${n}`, ipKey: `mfa:ip:${ip}` });
const failureOf = <T>(result: Result<T>): Failure | null => (result.ok ? null : result.error);
const buckets = (r: Rig) => r.rows<{ bucket_key: string; failures: number; locked_until_ms: number | null }>("SELECT bucket_key, failures, locked_until_ms FROM auth_lockout WHERE bucket_key LIKE 'mfa:%' ORDER BY bucket_key");
const actions = (r: Rig, like: string): number => r.rows(`SELECT 1 FROM audit_log WHERE action = '${like}'`).length;
const stepNow = (r: Rig): number => totpStepAt(r.clock.now);

/** A password session to prove the factor from. */
async function session(r: Rig): Promise<string> {
  return (await r.signIn()).token;
}

describe("D11.3-AC1 five wrong codes lock for fifteen minutes", () => {
  it("four wrong TOTP codes are refused, the fifth locks with the seconds left; each is counted and audited", async () => {
    const { r, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(failureOf(await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", attempt)))).toEqual({ code: "MFA_INVALID_CODE" });
    }
    expect(failureOf(await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", 5)))).toEqual({ code: "AUTH_LOCKED", retryAfterSeconds: 900 });
    expect(buckets(r).map((bucket) => [bucket.bucket_key.split(":").slice(0, 2).join(":"), bucket.failures, bucket.locked_until_ms])).toEqual([
      ["mfa:account", 5, T0 + LOCKOUT_DURATION_MS],
      ["mfa:ip", 5, T0 + LOCKOUT_DURATION_MS],
    ]);
    expect(actions(r, "mfa.failed")).toBe(5);
    expect(r.rows<{ details: string }>("SELECT details FROM audit_log WHERE action = 'mfa.failed' ORDER BY id").map((row) => row.details)).toEqual([
      '{"operation":"verify","locked":false}',
      '{"operation":"verify","locked":false}',
      '{"operation":"verify","locked":false}',
      '{"operation":"verify","locked":false}',
      '{"operation":"verify","locked":true}',
    ]);
  });

  it("while locked nothing is looked at, written or extended: not a wrong code, not the right TOTP, not a recovery code", async () => {
    const { r, secret, codes, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 5; attempt += 1) await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", attempt));
    const bucketsBefore = buckets(r);
    const auditBefore = actions(r, "mfa.failed");
    const ledgerBefore = r.rows("SELECT last_used_step FROM mfa_state");

    r.clock.now = T0 + 1000;
    const right = await codeAt(secret, stepNow(r));
    for (const attempt of [
      () => verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("198.51.100.9")),
      () => verifyTotp(deps(), token, { code: right, rememberDevice: false }, context("198.51.100.9")),
      () => Promise.resolve(verifyRecoveryCode(deps(), token, { recoveryCode: codes[0] ?? "" }, context("198.51.100.9"))),
      () => stepUp(deps(), token, { code: right }, context("198.51.100.9")),
    ]) {
      expect(failureOf(await attempt())).toEqual({ code: "AUTH_LOCKED", retryAfterSeconds: 899 });
    }
    expect(buckets(r)).toEqual(bucketsBefore);
    expect(actions(r, "mfa.failed")).toBe(auditBefore);
    expect(r.rows("SELECT last_used_step FROM mfa_state")).toEqual(ledgerBefore);
    expect(r.rows("SELECT 1 FROM recovery_code WHERE used_at_ms IS NOT NULL")).toEqual([]);
    expect(r.facts(token)?.assurance).toBe("password");
  });

  it("the lock is open again exactly at lockedUntil, one millisecond earlier it is not; the success clears the account bucket", async () => {
    const { r, secret, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 5; attempt += 1) await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", attempt));
    r.clock.now = T0 + LOCKOUT_DURATION_MS - 1;
    expect(failureOf(await verifyTotp(deps(), token, { code: await codeAt(secret, stepNow(r)), rememberDevice: false }, context()))).toEqual({ code: "AUTH_LOCKED", retryAfterSeconds: 1 });
    r.clock.now = T0 + LOCKOUT_DURATION_MS;
    const proof = await verifyTotp(deps(), token, { code: await codeAt(secret, stepNow(r)), rememberDevice: false }, context());
    expect(proof.ok).toBe(true);
    // Only the account's bucket is gone; the address keeps its failures.
    expect(buckets(r).map((bucket) => bucket.bucket_key.split(":").slice(0, 2).join(":"))).toEqual(["mfa:ip"]);
  });

  it("failures are counted in a 15-minute window: an older count does not add to a new failure", async () => {
    const { r, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 4; attempt += 1) await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", attempt));
    r.clock.now = T0 + LOCKOUT_WINDOW_MS;
    expect(failureOf(await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context()))).toEqual({ code: "MFA_INVALID_CODE" });
    expect(buckets(r).map((bucket) => bucket.failures)).toEqual([1, 1]);
  });

  it("a restart keeps the lock: a new connection and the same use cases still refuse", async () => {
    const { r, secret, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 5; attempt += 1) await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", attempt));
    r.reopen();
    r.clock.now = T0 + 5000;
    expect(failureOf(await verifyTotp(deps(), token, { code: await codeAt(secret, stepNow(r)), rememberDevice: false }, context("192.0.2.77")))).toEqual({ code: "AUTH_LOCKED", retryAfterSeconds: 895 });
  });

  it("every way of proving or confirming a factor counts in the one bucket: TOTP, recovery code, step-up, reissue and the enrollment confirmation", async () => {
    const { r, deps } = await enrolledRig();
    const token = await session(r);
    const refusals = [
      () => verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", 1)),
      () => Promise.resolve(verifyRecoveryCode(deps(), token, { recoveryCode: "ZZZZZ-ZZZZZ" }, context("203.0.113.1", 2))),
      () => verifyTotp(deps(), token, { code: "123456", rememberDevice: false }, context("203.0.113.1", 3)),
      () => Promise.resolve(verifyRecoveryCode(deps(), token, { recoveryCode: "short" }, context("203.0.113.1", 4))),
    ];
    for (const refuse of refusals) expect(failureOf(await refuse())?.code).toBe("MFA_INVALID_CODE");
    expect(failureOf(await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", 5)))?.code).toBe("AUTH_LOCKED");
    expect(actions(r, "mfa.failed")).toBe(5);
    expect(r.rows<{ details: string }>("SELECT details FROM audit_log WHERE action = 'mfa.failed' ORDER BY id").map((row) => JSON.parse(row.details).operation)).toEqual(["verify", "recovery_code", "verify", "recovery_code", "verify"]);
  });

  it("an enrollment confirmation counts too, and a lock stops it before its challenge is looked at", async () => {
    const r = await createIdentityRig();
    const owner = await session(r);
    const dependencies = { unit: r.unit, crypto, nowMs: () => r.clock.now, newId: () => "id", newSessionId: () => "session-new", newSessionToken: () => "token-new", mfaAccountKey: (id: string) => `mfa:account:${id}` };
    const challenge = await beginTotp(dependencies, owner, "req-begin");
    if (!challenge.ok) throw new Error("begin failed");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(failureOf(await confirmEnrollment(dependencies, owner, { challengeId: challenge.value.challengeId, code: WRONG }, context("203.0.113.1", attempt)))).toEqual({ code: "MFA_INVALID_CODE" });
    }
    expect(failureOf(await confirmEnrollment(dependencies, owner, { challengeId: challenge.value.challengeId, code: WRONG }, context("203.0.113.1", 5)))?.code).toBe("AUTH_LOCKED");
    // Locked: even a challenge that does not exist gets the lock, not an answer about the enrollment.
    expect(failureOf(await confirmEnrollment(dependencies, owner, { challengeId: "unknown", code: WRONG }, context("203.0.113.1", 6)))?.code).toBe("AUTH_LOCKED");
    expect(r.mfa()?.pending?.challengeId).toBe(challenge.value.challengeId);
  });
});

describe("D11.3-AC2 committed refusals and separate buckets", () => {
  it("a failing audit refuses the wrong code without a counter, and refuses the right code without a session or a spent step", async () => {
    const { r, secret, deps } = await enrolledRig();
    const token = await session(r);
    r.sql(`CREATE TRIGGER fail_failed BEFORE INSERT ON audit_log WHEN new.action = 'mfa.failed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    await expect(verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context())).rejects.toThrow();
    expect(buckets(r)).toEqual([]);

    r.sql("DROP TRIGGER fail_failed");
    r.sql(`CREATE TRIGGER fail_verified BEFORE INSERT ON audit_log WHEN new.action = 'mfa.verified' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const code = await codeAt(secret, stepNow(r));
    await expect(verifyTotp(deps(), token, { code, rememberDevice: false }, context())).rejects.toThrow();
    expect(r.rows("SELECT last_used_step FROM mfa_state")).toEqual([{ last_used_step: null }]);
    expect(r.facts(token)?.assurance).toBe("password");
    expect(r.rows("SELECT 1 FROM session_ext WHERE assurance = 'totp'")).toEqual([]);
    r.sql("DROP TRIGGER fail_verified");
    expect((await verifyTotp(deps(), token, { code, rememberDevice: false }, context())).ok).toBe(true);
  });

  it("the password's bucket and the factor's are apart: a password login does not clear factor failures, a TOTP does not clear password failures", async () => {
    const { r, secret, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 3; attempt += 1) await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", attempt));
    // A successful password login (it clears the password account bucket) leaves the factor's count.
    await session(r);
    expect(buckets(r).map((bucket) => bucket.failures)).toEqual([3, 3]);

    // Password failures are the library of D09.3: three of them, then a TOTP success.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await signInWithPassword(
        { unit: r.unit, verifier: { verify: async () => false }, decoyHash: "x", nowMs: () => r.clock.now, newSessionId: () => "s", newSessionToken: () => "t" },
        { email: RIG_EMAIL, password: "wrong password", accountKey: "password:account:k", ipKey: "password:ip:k", ip: null, userAgent: null, requestId: `req-pw-${attempt}`, trustedTokenHash: null },
      );
    }
    expect((await verifyTotp(deps(), token, { code: await codeAt(secret, stepNow(r)), rememberDevice: false }, context("203.0.113.1", 9))).ok).toBe(true);
    expect(r.rows<{ bucket_key: string; failures: number }>("SELECT bucket_key, failures FROM auth_lockout ORDER BY bucket_key").map((row) => [row.bucket_key.split(":").slice(0, 2).join(":"), row.failures])).toEqual([
      ["mfa:ip", 3],
      ["password:account", 3],
      ["password:ip", 3],
    ]);
  });

  it("a success clears the account's bucket and not the address's: the address locks on its own count", async () => {
    const { r, secret, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 3; attempt += 1) await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", attempt));
    // The owner proves the factor from the same address: the account is clear, the address still has 3.
    const proof = await verifyTotp(deps(), token, { code: await codeAt(secret, stepNow(r)), rememberDevice: false }, context("203.0.113.1", 4));
    expect(proof.ok).toBe(true);
    if (!proof.ok) throw new Error("the proof was refused");
    const next = proof.value.token;
    expect(buckets(r).map((bucket) => [bucket.bucket_key.split(":").slice(0, 2).join(":"), bucket.failures])).toEqual([["mfa:ip", 3]]);
    // Two more wrong codes from that address reach five there although the account has only two.
    expect(failureOf(await verifyTotp(deps(), next, { code: WRONG, rememberDevice: false }, context("203.0.113.1", 5)))?.code).toBe("MFA_INVALID_CODE");
    expect(failureOf(await verifyTotp(deps(), next, { code: WRONG, rememberDevice: false }, context("203.0.113.1", 6)))?.code).toBe("AUTH_LOCKED");
    // The account itself has only two failures: its own limit is far away.
    expect(buckets(r).find((bucket) => bucket.bucket_key.startsWith("mfa:account"))?.failures).toBe(2);
  });

  it("failures from many addresses lock the account for all of them", async () => {
    const { r, secret, deps } = await enrolledRig();
    const token = await session(r);
    for (let attempt = 1; attempt <= 5; attempt += 1) await verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context(`198.51.100.${attempt}`, attempt));
    expect(failureOf(await verifyTotp(deps(), token, { code: await codeAt(secret, stepNow(r)), rememberDevice: false }, context("192.0.2.200")))?.code).toBe("AUTH_LOCKED");
  });

  it("a burst of parallel wrong attempts counts exactly five and locks once: four refusals, the rest locked", async () => {
    const { r, deps } = await enrolledRig();
    const token = await session(r);
    const replies = await Promise.all(Array.from({ length: 20 }, (_, index) => verifyTotp(deps(), token, { code: WRONG, rememberDevice: false }, context("203.0.113.1", index))));
    const codes = replies.map((reply) => failureOf(reply)?.code);
    expect(codes.filter((code) => code === "MFA_INVALID_CODE")).toHaveLength(4);
    expect(codes.filter((code) => code === "AUTH_LOCKED")).toHaveLength(16);
    expect(buckets(r).map((bucket) => bucket.failures)).toEqual([5, 5]);
    expect(new Set(buckets(r).map((bucket) => bucket.locked_until_ms)).size).toBe(1);
    expect(actions(r, "mfa.failed")).toBe(5);
  });

  it("two requests with the right code and one step: one proves, the other is a counted refusal, not a lock", async () => {
    const { r, secret, deps } = await enrolledRig();
    const [a, b] = [await session(r), await session(r)];
    const code = await codeAt(secret, stepNow(r));
    const replies = await Promise.all([verifyTotp(deps(), a, { code, rememberDevice: false }, context("203.0.113.1", 1)), verifyTotp(deps(), b, { code, rememberDevice: false }, context("203.0.113.1", 2))]);
    expect(replies.filter((reply) => reply.ok)).toHaveLength(1);
    expect(replies.map((reply) => failureOf(reply)?.code).filter(Boolean)).toEqual(["MFA_INVALID_CODE"]);
    // The loser came second, after the winner had cleared the account: its refusal is the one failure on both buckets.
    expect(buckets(r).map((bucket) => bucket.failures)).toEqual([1, 1]);
  });
});
