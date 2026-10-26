// What the commands that act on a live session share (Architektura §9.7, §18.7): who the caller
// is according to the database, the failures a command ends with, and the session that replaces
// the caller's when a factor was proven. Nothing here decides access: the policy does.
import { DomainFault, type Commit, type FailureCode, type Result } from "../../../foundation/public.js";
import { decideAccess, type Assurance, type IdentityAccessSnapshot } from "../domain/access-policy.js";
import { SESSION_LIFETIME_MS } from "../domain/session-policy.js";
import type { EnrollmentPorts, MfaRecord, NewSession, SessionFacts } from "../ports.js";

/** Ends a unit of work with an expected failure; everything the unit wrote is rolled back. */
export const fail = (code: FailureCode): never => {
  throw new DomainFault({ code });
};
export const failed = <T>(code: FailureCode): Result<T> => ({ ok: false, error: { code } });
export const commit = <T>(value: T): Commit<T> => ({ value, invalidations: [] });

export type Caller = Readonly<{ session: SessionFacts; snapshot: IdentityAccessSnapshot; mfa: MfaRecord; email: string }>;

/** The session of this token and the state around it, or null if the caller is not the owner's live session. */
export function callerOf(ports: EnrollmentPorts, token: string, nowMs: number, requestId: string): Caller | null {
  const session = ports.sessions.findActive(token, nowMs);
  const mfa = ports.mfa.read();
  const email = ports.credentialReader.ownerEmail();
  if (session === null || mfa === null || email === null) {
    return null;
  }
  const snapshot = ports.access.current({ ownerId: session.ownerId, sessionId: session.sessionId, requestId, accessEpoch: session.accessEpoch });
  const decision = decideAccess(snapshot, "data", nowMs);
  // Identity is what matters here; the other denials (factor, acknowledgment, data) are the states being resolved.
  return !decision.allow && decision.code === "AUTH_REQUIRED" ? null : { session, snapshot, mfa, email };
}

export const context = (caller: Caller, generation: number) => ({ ownerId: caller.session.ownerId, generation });

/** The session that replaces the one that proved a factor: same owner and epoch, a new identity and token. */
export function replacementSession(
  old: SessionFacts,
  proof: Readonly<{ assurance: Assurance; totpVerifiedAtMs: number | null }>,
  nowMs: number,
  ids: Readonly<{ sessionId: string; token: string }>,
): NewSession {
  return {
    sessionId: ids.sessionId,
    token: ids.token,
    ownerId: old.ownerId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + SESSION_LIFETIME_MS,
    ipAddress: null,
    userAgent: null,
    assurance: proof.assurance,
    passwordVerifiedAtMs: old.passwordVerifiedAtMs,
    totpVerifiedAtMs: proof.totpVerifiedAtMs,
    accessEpoch: old.accessEpoch,
    // A proof of its own never leans on a device.
    trustedDeviceId: null,
  };
}
