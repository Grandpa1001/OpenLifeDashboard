// Password sign-in, sign-out and status (Architektura §9.8, §18.7; D09.3).
//
// Sign-in is three steps because hashing is asynchronous and must stay outside a unit of work:
// (1) a unit decides whether the request may be tried (locks) and reads the credential, (2) the
// password is verified with the shared hasher, (3) a unit checks the locks and the credential
// again and commits the outcome. A refusal is a committed outcome, not a DomainFault: the
// failure counters and the audit entry must survive the 401/429. If anything in step 3 throws
// (an audit append that fails), the unit rolls back, no session exists and the caller answers
// "unavailable".
import type { Commit, ReadUnit, UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, nextActionFor, type NextAction } from "../domain/access-policy.js";
import { SESSION_LIFETIME_MS } from "../domain/session-policy.js";
import type { OwnerCredential, SignInPorts } from "../ports.js";
import { clearAccountBucket, lockedFor, registerFailure, type BucketKeys } from "./lockout-buckets.js";

export interface PasswordVerifier {
  /** False for a wrong password. */
  verify(storedHash: string, password: string): Promise<boolean>;
}

export type SignInDependencies = Readonly<{
  unit: UnitOfWork<SignInPorts> & ReadUnit<SignInPorts>;
  verifier: PasswordVerifier;
  /**
   * A hash of a random password, verified for an unknown e-mail so that the cost of a refusal
   * does not tell the owner's e-mail from a foreign one.
   */
  decoyHash: string;
  nowMs: () => number;
  newSessionId: () => string;
  newSessionToken: () => string;
}>;

export type SignInRequest = Readonly<{
  /** Normalized by the contract. */
  email: string;
  password: string;
  /** Opaque hashed keys of the two buckets; the caller derives them from the e-mail and the client IP. */
  accountKey: string;
  ipKey: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  /** Hash of the trusted-device token the browser sent, if any; trust is checked, never assumed. */
  trustedTokenHash: string | null;
}>;

/** Approved outcome of an attempt; a refusal carries no session or token. */
export type AuthAttemptOutcome =
  | Readonly<{ kind: "granted"; token: string; expiresAtMs: number; nextAction: NextAction }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "locked"; retryAfterSeconds: number }>;

const commit = <T>(value: T): Commit<T> => ({ value, invalidations: [] });

export async function signInWithPassword(deps: SignInDependencies, request: SignInRequest): Promise<AuthAttemptOutcome> {
  const keys: BucketKeys = { account: request.accountKey, ip: request.ipKey };
  // Step 1 only reads (locks, credential): it takes no write lock and cannot write.
  const first = deps.unit.read((ports) => {
    const retryAfter = lockedFor(ports, keys, deps.nowMs());
    return { retryAfter, credential: retryAfter === null ? ports.credentialReader.findOwnerByEmail(request.email) : null };
  });
  const { retryAfter, credential } = first;
  if (retryAfter !== null) {
    return { kind: "locked", retryAfterSeconds: retryAfter };
  }
  const verified = credential
    ? await deps.verifier.verify(credential.passwordHash, request.password)
    : (await deps.verifier.verify(deps.decoyHash, request.password), false);

  const second = deps.unit.run((ports) => commit(decide(ports, deps, request, keys, credential, verified)));
  if (!second.ok) {
    throw new Error("sign-in commit failed");
  }
  return second.value.value;
}

function decide(
  ports: SignInPorts,
  deps: SignInDependencies,
  request: SignInRequest,
  keys: BucketKeys,
  checked: OwnerCredential | null,
  verified: boolean,
): AuthAttemptOutcome {
  const nowMs = deps.nowMs();
  const retryAfter = lockedFor(ports, keys, nowMs);
  if (retryAfter !== null) {
    // Locked while the password was being verified: no session, and the lock is not extended.
    return { kind: "locked", retryAfterSeconds: retryAfter };
  }
  // The credential is read again: a password verified against a hash that has been replaced
  // since step 1 proves nothing about the current one.
  const current = ports.credentialReader.findOwnerByEmail(request.email);
  const accessEpoch = ports.owners.currentAccessEpoch();
  const granted =
    verified && checked !== null && current !== null && accessEpoch !== null && current.ownerId === checked.ownerId && current.passwordHash === checked.passwordHash;
  if (granted) {
    // A valid trusted device stands in for the second factor of an enrolled owner, only then.
    const mfa = ports.mfa.read();
    const device =
      request.trustedTokenHash !== null && mfa?.policy === "required" && mfa.enrollmentState === "complete"
        ? ports.trusted.findValid(request.trustedTokenHash, nowMs)
        : null;
    const token = deps.newSessionToken();
    const sessionId = deps.newSessionId();
    const expiresAtMs = nowMs + SESSION_LIFETIME_MS;
    clearAccountBucket(ports, keys);
    ports.sessions.insert({
      sessionId,
      token,
      ownerId: checked.ownerId,
      createdAtMs: nowMs,
      expiresAtMs,
      ipAddress: request.ip,
      userAgent: request.userAgent,
      assurance: device === null ? "password" : "trusted",
      passwordVerifiedAtMs: nowMs,
      // Trust never produces a TOTP time: a step-up still needs a fresh code.
      totpVerifiedAtMs: null,
      accessEpoch,
      trustedDeviceId: device?.deviceId ?? null,
    });
    ports.audit.append({
      ownerId: checked.ownerId,
      action: "login.succeeded",
      entityId: request.requestId,
      at: new Date(nowMs).toISOString(),
      requestId: request.requestId,
      details: { trusted: device !== null },
      ...(request.ip === null ? {} : { ip: request.ip }),
      ...(request.userAgent === null ? {} : { userAgent: request.userAgent }),
    });
    // What happens next comes from the same policy as every later decision, read after the insert.
    const snapshot = ports.access.current({ ownerId: checked.ownerId, sessionId, requestId: request.requestId, accessEpoch });
    return { kind: "granted", token, expiresAtMs, nextAction: nextActionFor(snapshot, nowMs) };
  }

  const lockSeconds = registerFailure(ports, keys, nowMs);
  const lockedNow = lockSeconds !== null;
  ports.audit.append({
    ownerId: null,
    action: "login.failed",
    entityId: request.requestId,
    at: new Date(nowMs).toISOString(),
    requestId: request.requestId,
    details: { ownerMatched: current !== null, locked: lockedNow },
    ...(request.ip === null ? {} : { ip: request.ip }),
    ...(request.userAgent === null ? {} : { userAgent: request.userAgent }),
  });
  return lockSeconds !== null ? { kind: "locked", retryAfterSeconds: lockSeconds } : { kind: "denied" };
}

export type IdentityStatus = Readonly<{ authenticated: boolean; nextAction: NextAction }>;

/** Status from the server state only: the session row and the current policy, never the cookie alone. */
export function readIdentityStatus(unit: ReadUnit<SignInPorts>, token: string | null, nowMs: number): IdentityStatus {
  return unit.read((ports) => {
    const session = token === null ? null : ports.sessions.findActive(token, nowMs);
    if (session !== null) {
      const snapshot = ports.access.current({ ownerId: session.ownerId, sessionId: session.sessionId, requestId: "status", accessEpoch: session.accessEpoch });
      // A session of a stale epoch is not authenticated: the policy answers AUTH_REQUIRED for it.
      const decision = decideAccess(snapshot, "data", nowMs);
      const authenticated = decision.allow || decision.code !== "AUTH_REQUIRED";
      if (authenticated) {
        return { authenticated, nextAction: nextActionFor(snapshot, nowMs) };
      }
    }
    return { authenticated: false, nextAction: ports.owners.hasOwner() ? "login" : "create_owner" } satisfies IdentityStatus;
  });
}

/** Idempotent: ending a session that does not exist is not an error. */
export function signOut(unit: UnitOfWork<SignInPorts>, token: string | null): void {
  if (token === null) {
    return;
  }
  const done = unit.run((ports) => commit(ports.sessions.deleteByToken(token)));
  if (!done.ok) {
    throw new Error("sign-out failed");
  }
}
