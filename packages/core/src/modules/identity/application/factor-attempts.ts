// Counting the refusals of the second factor (Architektura §9.8; D11.3). Every attempt to prove a
// factor (the enrollment confirmation, the reissue, the login TOTP or recovery code, the step-up)
// counts in the same two buckets, apart from the password's: the owner's account and the client
// address. A blocked request is answered before any code is looked at and writes nothing; a wrong
// code is a *committed* outcome, so the counter and the audit entry survive the 401/429; a success
// clears only the account's bucket.
import type { Failure, Result, UnitOfWork } from "../../../foundation/public.js";
import { commit } from "./caller.js";
import { lockedFor, registerFailure, type BucketKeys } from "./lockout-buckets.js";
import type { EnrollmentPorts } from "../ports.js";

/** What identifies a request beyond its session: the id for the audit, the hashed key of the client address. */
export type RequestContext = Readonly<{ requestId: string; ipKey: string }>;

export type FactorOperation = "enrollment_confirm" | "recovery_reissue" | "verify" | "recovery_code" | "step_up";

export type AttemptDependencies = Readonly<{
  /** The opaque, hashed bucket key of an owner's account for the second factor. */
  mfaAccountKey: (ownerId: string) => string;
}>;

export const bucketKeysOf = (deps: AttemptDependencies, ownerId: string, context: RequestContext): BucketKeys => ({ account: deps.mfaAccountKey(ownerId), ip: context.ipKey });

export const lockedResult = <T>(retryAfterSeconds: number): Result<T> => ({ ok: false, error: { code: "AUTH_LOCKED", retryAfterSeconds } satisfies Failure });
export const invalidCodeResult = <T>(): Result<T> => ({ ok: false, error: { code: "MFA_INVALID_CODE" } });

/** Counts a wrong code inside the unit of a refusal that must commit; the lock it sets, if any, in seconds. */
export function recordRefusal(
  ports: EnrollmentPorts,
  keys: BucketKeys,
  nowMs: number,
  who: Readonly<{ ownerId: string; operation: FactorOperation; requestId: string }>,
): Failure {
  const lockSeconds = registerFailure(ports, keys, nowMs);
  ports.audit.append({
    ownerId: who.ownerId,
    action: "mfa.failed",
    entityId: who.ownerId,
    at: new Date(nowMs).toISOString(),
    requestId: who.requestId,
    details: { operation: who.operation, locked: lockSeconds !== null },
  });
  return lockSeconds === null ? { code: "MFA_INVALID_CODE" } : { code: "AUTH_LOCKED", retryAfterSeconds: lockSeconds };
}

/**
 * A wrong code, outside any unit that proves a factor: re-checks the lock (it may have been set
 * while the code was being checked), counts the failure and commits it. Throws if the audit fails,
 * which the route answers as unavailable: nothing is counted and nothing is granted.
 */
export function refuseWrongCode<T>(
  deps: AttemptDependencies & Readonly<{ unit: UnitOfWork<EnrollmentPorts> }>,
  nowMs: number,
  who: Readonly<{ ownerId: string; operation: FactorOperation; context: RequestContext }>,
): Result<T> {
  const keys = bucketKeysOf(deps, who.ownerId, who.context);
  const outcome = deps.unit.run((ports) => {
    const locked = lockedFor(ports, keys, nowMs);
    // Already locked: the lock is not extended and nothing is written.
    const failure: Failure = locked !== null ? { code: "AUTH_LOCKED", retryAfterSeconds: locked } : recordRefusal(ports, keys, nowMs, { ownerId: who.ownerId, operation: who.operation, requestId: who.context.requestId });
    return commit(failure);
  });
  if (!outcome.ok) {
    throw new Error("recording a refusal failed");
  }
  return { ok: false, error: outcome.value.value };
}
