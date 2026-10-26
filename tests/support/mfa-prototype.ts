// The second-factor steps of the D10 prototype, composed from the production adapters (secret
// box, TOTP verifier, MFA store, session rotation, audit). They are test code: D11 implements the
// same steps as use cases with routes, recovery codes and acknowledgment. They show the order the
// design needs: the code is checked outside a unit of work, one unit then does the compare-and-set
// of the replay ledger or the pending secret, rotates the session and audits, and the new token
// exists only if that unit committed.
import { createOTP } from "@better-auth/utils/otp";
import { createSecretBox } from "../../apps/server/dist/adapters/auth/secret-box.js";
import { createTotp } from "../../apps/server/dist/adapters/auth/totp.js";
import { done, type IdentityRig } from "./identity-rig.ts";

export const PROTOTYPE_KEY = "9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e1b3d5f7a9c1e3b5d7f90";
export const PENDING_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 30 * 24 * 3600 * 1000;

export const box = createSecretBox(PROTOTYPE_KEY);
export const totp = createTotp();

export const codeAt = (secret: string, step: number): Promise<string> => createOTP(Buffer.from(secret, "base64url"), { digits: 6, period: 30 }).hotp(step);

/** Enrollment, step 1: a pending secret sealed for the generation it will have once active. */
export function beginEnrollment(r: IdentityRig, challengeId: string, sealedForGeneration?: number): { secret: string } {
  const secret = totp.generateSecret();
  const generation = r.mfa()?.secretGeneration ?? 0;
  const sealed = box.seal(secret, { ownerId: "owner-1", generation: sealedForGeneration ?? generation + 1 });
  r.unit.run((ports) => {
    ports.mfa.savePending({ challengeId, secret: sealed, expiresAtMs: r.clock.now + PENDING_LIFETIME_MS });
    return done(null);
  });
  return { secret };
}

/** Gives the owner an active secret and a complete enrollment, as a finished D11 enrollment would. */
export function activateSecret(r: IdentityRig, generation = 1): string {
  const secret = totp.generateSecret();
  r.connection.handle
    .prepare("UPDATE mfa_state SET secret_generation = ?, active_secret = ?, enrollment_state = 'complete'")
    .run(generation, box.seal(secret, { ownerId: "owner-1", generation }));
  return secret;
}

const promotedSession = (r: IdentityRig, newToken: string, old: NonNullable<ReturnType<IdentityRig["facts"]>>) => ({
  sessionId: `session-${newToken}`,
  token: newToken,
  ownerId: old.ownerId,
  createdAtMs: r.clock.now,
  expiresAtMs: r.clock.now + SESSION_LIFETIME_MS,
  ipAddress: "127.0.0.1",
  userAgent: "vitest",
  assurance: "totp" as const,
  passwordVerifiedAtMs: old.passwordVerifiedAtMs,
  totpVerifiedAtMs: r.clock.now,
  accessEpoch: old.accessEpoch,
});

/**
 * Enrollment, step 2: the code is checked against the opened pending secret, then one unit
 * activates it, rotates the session and audits. Returns the new token, or null.
 */
export async function confirmEnrollment(r: IdentityRig, oldToken: string, challengeId: string, code: string, newToken: string): Promise<string | null> {
  const record = r.mfa();
  if (record?.pending?.challengeId !== challengeId) return null;
  const secret = box.open(record.pending.secret, { ownerId: "owner-1", generation: record.secretGeneration + 1 });
  if (secret === null) return null;
  const step = await totp.verify(secret, code, r.clock.now);
  if (step === null || step <= (record.lastUsedStep ?? -1)) return null;
  const old = r.facts(oldToken);
  if (old === null) return null;
  const result = r.unit.run((ports) => {
    const activated = ports.mfa.activatePending({ challengeId, expectedGeneration: record.secretGeneration, usedStep: step, nowMs: r.clock.now });
    const rotated = activated && ports.sessions.rotate(oldToken, promotedSession(r, newToken, old));
    if (rotated) {
      ports.audit.append({ ownerId: old.ownerId, action: "mfa.enrolled", entityId: old.ownerId, at: new Date(r.clock.now).toISOString(), requestId: "req-enroll" });
    }
    return done(rotated);
  });
  return result.ok && result.value.value ? newToken : null;
}

export type PromotionResult = "promoted" | "invalid" | "replayed";

/**
 * Login challenge: a password session proves the active secret. `beforeCommit` lets a test hold
 * the request between the verification and the unit, so several requests can pass the check
 * before any commits. A thrown error (a failing audit) rolls the whole unit back.
 */
export async function promoteWithTotp(
  r: IdentityRig,
  oldToken: string,
  code: string,
  newToken: string,
  beforeCommit: () => Promise<void> = async () => undefined,
): Promise<PromotionResult> {
  const record = r.mfa();
  if (record?.activeSecret == null) return "invalid";
  const secret = box.open(record.activeSecret, { ownerId: "owner-1", generation: record.secretGeneration });
  const step = secret === null ? null : await totp.verify(secret, code, r.clock.now);
  if (step === null) return "invalid";
  const old = r.facts(oldToken);
  if (old === null) return "invalid";
  await beforeCommit();
  const result = r.unit.run((ports) => {
    // The ledger is the only authority: the step read above is not trusted any more.
    if (!ports.mfa.consumeStep({ expectedGeneration: record.secretGeneration, step })) {
      return done<PromotionResult>("replayed");
    }
    if (!ports.sessions.rotate(oldToken, promotedSession(r, newToken, old))) {
      throw new Error("the session ended during the verification");
    }
    ports.audit.append({ ownerId: old.ownerId, action: "mfa.verified", entityId: old.ownerId, at: new Date(r.clock.now).toISOString(), requestId: `req-${newToken}` });
    return done<PromotionResult>("promoted");
  });
  if (!result.ok) throw new Error("promotion failed");
  return result.value.value;
}
