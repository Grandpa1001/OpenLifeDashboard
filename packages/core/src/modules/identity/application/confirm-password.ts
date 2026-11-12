// Proving the password again while the second factor is off (Scope §5.9; Architektura §9.6; D43.5). With the
// factor off the proof of a sensitive action is a password typed in the last five minutes, so there must be a
// way to type it without changing anything: this. The password is verified outside a unit of work, like at
// sign-in, and counts in the same buckets (a wrong one is a counted outcome); a right one replaces the session
// with one that has the password proved now and keeps everything else it had. With the factor in force the
// password proves nothing a step-up accepts, so the request is refused as not what the owner is in.
import type { Commit, Failure, ReadUnit, Result, UnitOfWork } from "../../../foundation/public.js";
import { decideAccess } from "../domain/access-policy.js";
import type { ConfirmPasswordPorts, OwnerCredential, SessionFacts } from "../ports.js";
import { clearAccountBucket, lockedFor, registerFailure, type BucketKeys } from "./lockout-buckets.js";
import { resolveSessionAccess } from "./session-access.js";
import { renewedSession } from "./session-renewal.js";
import type { PasswordVerifier } from "./sign-in.js";

export type ConfirmPasswordDependencies = Readonly<{
  unit: UnitOfWork<ConfirmPasswordPorts> & ReadUnit<ConfirmPasswordPorts>;
  verifier: PasswordVerifier;
  nowMs: () => number;
  newSessionId: () => string;
  newSessionToken: () => string;
  /** The opaque keys of the password buckets from the owner's e-mail and the client address. */
  keysOf: (email: string, ipKey: string) => BucketKeys;
}>;

export type PasswordConfirmed = Readonly<{ token: string; expiresAtMs: number }>;

type Reading = Readonly<{ session: SessionFacts; credential: OwnerCredential; keys: BucketKeys }>;

const refuse = (failure: Failure): Result<never> => ({ ok: false, error: failure });
const commit = <T>(value: T): Commit<T> => ({ value, invalidations: [] });

export async function confirmOwnerPassword(
  deps: ConfirmPasswordDependencies,
  token: string,
  password: string,
  who: Readonly<{ requestId: string; ipKey: string }>,
): Promise<Result<PasswordConfirmed>> {
  const first = deps.unit.read((ports): Result<Reading> => {
    const nowMs = deps.nowMs();
    const access = resolveSessionAccess(ports, token, nowMs, who.requestId);
    if (access === null) return refuse({ code: "AUTH_REQUIRED" });
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) return refuse({ code: decision.code });
    if (access.snapshot.mfaPolicy !== "disabled") return refuse({ code: "ENROLLMENT_CHANGED" });
    const email = ports.credentialReader.ownerEmail();
    const credential = email === null ? null : ports.credentialReader.findOwnerByEmail(email);
    if (email === null || credential === null) return refuse({ code: "OWNER_NOT_FOUND" });
    const keys = deps.keysOf(email, who.ipKey);
    const locked = lockedFor(ports, keys, nowMs);
    return locked === null ? { ok: true, value: { session: access.session, credential, keys } } : refuse({ code: "AUTH_LOCKED", retryAfterSeconds: locked });
  });
  if (!first.ok) return first;
  const { credential, keys } = first.value;

  const verified = await deps.verifier.verify(credential.passwordHash, password);

  const committed = deps.unit.run((ports) => {
    const nowMs = deps.nowMs();
    const at = new Date(nowMs).toISOString();
    const access = resolveSessionAccess(ports, token, nowMs, who.requestId);
    if (access === null) return commit<Result<PasswordConfirmed>>(refuse({ code: "AUTH_REQUIRED" }));
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) return commit<Result<PasswordConfirmed>>(refuse({ code: decision.code }));
    if (access.snapshot.mfaPolicy !== "disabled") return commit<Result<PasswordConfirmed>>(refuse({ code: "ENROLLMENT_CHANGED" }));
    const locked = lockedFor(ports, keys, nowMs);
    if (locked !== null) return commit<Result<PasswordConfirmed>>(refuse({ code: "AUTH_LOCKED", retryAfterSeconds: locked }));
    const email = ports.credentialReader.ownerEmail();
    const current = email === null ? null : ports.credentialReader.findOwnerByEmail(email);
    const ownerId = access.session.ownerId;
    if (!verified || current === null || current.passwordHash !== credential.passwordHash) {
      const lockSeconds = registerFailure(ports, keys, nowMs);
      ports.audit.append({ ownerId, action: "password.confirm_failed", entityId: ownerId, at, requestId: who.requestId, details: { locked: lockSeconds !== null } });
      return commit<Result<PasswordConfirmed>>(refuse(lockSeconds === null ? { code: "INVALID_CREDENTIALS" } : { code: "AUTH_LOCKED", retryAfterSeconds: lockSeconds }));
    }
    const next = renewedSession(
      access.session,
      { assurance: access.session.assurance, passwordVerifiedAtMs: nowMs, totpVerifiedAtMs: access.session.totpVerifiedAtMs, accessEpoch: access.session.accessEpoch },
      nowMs,
      { sessionId: deps.newSessionId(), token: deps.newSessionToken() },
    );
    if (!ports.sessions.rotate(token, next)) return commit<Result<PasswordConfirmed>>(refuse({ code: "AUTH_REQUIRED" }));
    clearAccountBucket(ports, keys);
    ports.audit.append({ ownerId, action: "password.confirmed", entityId: ownerId, at, requestId: who.requestId, details: {} });
    return commit<Result<PasswordConfirmed>>({ ok: true, value: { token: next.token, expiresAtMs: next.expiresAtMs } });
  });
  if (!committed.ok) throw new Error("the confirmation of the password did not commit");
  return committed.value.value;
}
