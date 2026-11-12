// Changing the password from a live session (Scope §5.9; Architektura §9.6, §9.8; D43.3). It asks for the
// current password and a fresh second factor (the policy's `step_up`, read again in the unit that writes),
// then the new credential, the raised access epoch, the end of every other session, the revoked trusted
// devices and the audit entry commit together. The caller keeps working in a new session of the new epoch:
// the second factor it proved stays proven, and the password it just typed is its latest password proof.
// Hashing is asynchronous, so like sign-in it runs outside a unit of work: (1) a unit reads the policy, the
// locks and the credential, (2) the current password is verified and the new one hashed, (3) a unit checks
// everything again and commits. A wrong current password is a counted outcome in the buckets of the password
// (the same locks as sign-in), never a fault: its counters and audit entry must survive the refusal.
import type { Commit, Failure, ReadUnit, Result, UnitOfWork } from "../../../foundation/public.js";
import { decideAccess } from "../domain/access-policy.js";
import type { ChangePasswordPorts, OwnerCredential, SessionFacts } from "../ports.js";
import { clearAccountBucket, lockedFor, registerFailure, type BucketKeys } from "./lockout-buckets.js";
import { resolveSessionAccess } from "./session-access.js";
import { renewedSession } from "./session-renewal.js";
import type { PasswordVerifier } from "./sign-in.js";

export type PasswordHasherPort = PasswordVerifier & Readonly<{ hash(password: string): Promise<string> }>;

export type ChangePasswordDependencies = Readonly<{
  unit: UnitOfWork<ChangePasswordPorts> & ReadUnit<ChangePasswordPorts>;
  hasher: PasswordHasherPort;
  nowMs: () => number;
  newSessionId: () => string;
  newSessionToken: () => string;
  /** The opaque keys of the password buckets from the owner's e-mail and the client address. */
  keysOf: (email: string, ipKey: string) => BucketKeys;
}>;

export type ChangePasswordRequest = Readonly<{ currentPassword: string; newPassword: string }>;

/** The session that replaces the caller's after the change; the cookie is set only after the commit. */
export type PasswordChanged = Readonly<{ token: string; expiresAtMs: number; revokedSessions: number; revokedDevices: number }>;

type Reading = Readonly<{ session: SessionFacts; credential: OwnerCredential; keys: BucketKeys }>;

const refuse = (failure: Failure): Result<never> => ({ ok: false, error: failure });

export async function changeOwnerPassword(
  deps: ChangePasswordDependencies,
  token: string,
  request: ChangePasswordRequest,
  who: Readonly<{ requestId: string; ipKey: string }>,
): Promise<Result<PasswordChanged>> {
  const first = deps.unit.read((ports): Result<Reading> => {
    const nowMs = deps.nowMs();
    const access = resolveSessionAccess(ports, token, nowMs, who.requestId);
    if (access === null) return refuse({ code: "AUTH_REQUIRED" });
    const decision = decideAccess(access.snapshot, "step_up", nowMs);
    if (!decision.allow) return refuse({ code: decision.code });
    const email = ports.credentialReader.ownerEmail();
    const credential = email === null ? null : ports.credentialReader.findOwnerByEmail(email);
    if (email === null || credential === null) return refuse({ code: "OWNER_NOT_FOUND" });
    const keys = deps.keysOf(email, who.ipKey);
    const locked = lockedFor(ports, keys, nowMs);
    return locked === null ? { ok: true, value: { session: access.session, credential, keys } } : refuse({ code: "AUTH_LOCKED", retryAfterSeconds: locked });
  });
  if (!first.ok) return first;
  const { credential, keys } = first.value;

  const verified = await deps.hasher.verify(credential.passwordHash, request.currentPassword);
  // The new hash is made only for a right current password: a wrong one costs one verification.
  const newHash = verified ? await deps.hasher.hash(request.newPassword) : null;

  const committed = deps.unit.run((ports) => {
    const nowMs = deps.nowMs();
    const at = new Date(nowMs).toISOString();
    const access = resolveSessionAccess(ports, token, nowMs, who.requestId);
    if (access === null) return commit<Result<PasswordChanged>>(refuse({ code: "AUTH_REQUIRED" }));
    const decision = decideAccess(access.snapshot, "step_up", nowMs);
    if (!decision.allow) return commit<Result<PasswordChanged>>(refuse({ code: decision.code }));
    const locked = lockedFor(ports, keys, nowMs);
    if (locked !== null) return commit<Result<PasswordChanged>>(refuse({ code: "AUTH_LOCKED", retryAfterSeconds: locked }));
    // The credential is read again: a password verified against a hash replaced since proves nothing.
    const email = ports.credentialReader.ownerEmail();
    const current = email === null ? null : ports.credentialReader.findOwnerByEmail(email);
    const ownerId = access.session.ownerId;
    if (!verified || newHash === null || current === null || current.passwordHash !== credential.passwordHash) {
      const lockSeconds = registerFailure(ports, keys, nowMs);
      ports.audit.append({ ownerId, action: "password.change_failed", entityId: ownerId, at, requestId: who.requestId, details: { locked: lockSeconds !== null } });
      return commit<Result<PasswordChanged>>(refuse(lockSeconds === null ? { code: "INVALID_CREDENTIALS" } : { code: "AUTH_LOCKED", retryAfterSeconds: lockSeconds }));
    }
    if (!ports.credentials.replaceOwnerPassword({ ownerId, passwordHash: newHash, at })) return commit<Result<PasswordChanged>>(refuse({ code: "OWNER_NOT_FOUND" }));
    const accessEpoch = ports.owners.advanceAccessEpoch();
    // A device that granted this session is revoked below: the session stands on the factor it proved.
    const next = renewedSession(
      access.session,
      { assurance: access.session.assurance, passwordVerifiedAtMs: nowMs, totpVerifiedAtMs: access.session.totpVerifiedAtMs, accessEpoch },
      nowMs,
      { sessionId: deps.newSessionId(), token: deps.newSessionToken() },
    );
    if (!ports.sessions.rotate(token, next)) return commit<Result<PasswordChanged>>(refuse({ code: "AUTH_REQUIRED" }));
    const revokedSessions = ports.sessions.deleteAllButOne(ownerId, next.sessionId);
    const revokedDevices = ports.trusted.revokeAll(nowMs);
    clearAccountBucket(ports, keys);
    ports.audit.append({ ownerId, action: "owner.password_changed", entityId: ownerId, at, requestId: who.requestId, details: { accessEpoch, revokedSessions, revokedDevices } });
    return commit<Result<PasswordChanged>>({ ok: true, value: { token: next.token, expiresAtMs: next.expiresAtMs, revokedSessions, revokedDevices } });
  });
  if (!committed.ok) throw new Error("the change of the password did not commit");
  return committed.value.value;
}

const commit = <T>(value: T): Commit<T> => ({ value, invalidations: [] });
