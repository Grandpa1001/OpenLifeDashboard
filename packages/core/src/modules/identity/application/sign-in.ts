// Password sign-in, sign-out and status (Architektura §9.8, §18.7; D09.3).
//
// Sign-in is three steps because hashing is asynchronous and must stay outside a unit of work:
// (1) a unit decides whether the request may be tried (locks) and reads the credential, (2) the
// password is verified with the shared hasher, (3) a unit checks the locks and the credential
// again and commits the outcome. A refusal is a committed outcome, not a DomainFault: the
// failure counters and the audit entry must survive the 401/429. If anything in step 3 throws
// (an audit append that fails), the unit rolls back, no session exists and the caller answers
// "unavailable".
import type { Commit, UnitOfWork } from "../../../foundation/public.js";
import { afterFailure, retryAfterSeconds } from "../domain/lockout.js";
import { SESSION_LIFETIME_MS } from "../domain/session-policy.js";
import type { OwnerCredential, SignInPorts } from "../ports.js";

/** What the browser does next; the contract's NEXT_ACTIONS has the same values. */
export type NextAction = "create_owner" | "login" | "mfa_enrollment";

export interface PasswordVerifier {
  /** False for a wrong password. */
  verify(storedHash: string, password: string): Promise<boolean>;
}

export type SignInDependencies = Readonly<{
  unit: UnitOfWork<SignInPorts>;
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
}>;

/** Approved outcome of an attempt; a refusal carries no session or token. */
export type AuthAttemptOutcome =
  | Readonly<{ kind: "granted"; token: string; expiresAtMs: number; nextAction: NextAction }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "locked"; retryAfterSeconds: number }>;

const commit = <T>(value: T): Commit<T> => ({ value, invalidations: [] });

/** The longest remaining lock of the given buckets, or null if none is locked. */
function lockedFor(ports: SignInPorts, keys: readonly string[], nowMs: number): number | null {
  const remaining = keys.map((key) => retryAfterSeconds(ports.attempts.find(key), nowMs)).filter((seconds): seconds is number => seconds !== null);
  return remaining.length === 0 ? null : Math.max(...remaining);
}

export async function signInWithPassword(deps: SignInDependencies, request: SignInRequest): Promise<AuthAttemptOutcome> {
  const keys = [request.accountKey, request.ipKey];
  const first = deps.unit.run((ports) => {
    const retryAfter = lockedFor(ports, keys, deps.nowMs());
    return commit({ retryAfter, credential: retryAfter === null ? ports.credentialReader.findOwnerByEmail(request.email) : null });
  });
  if (!first.ok) {
    throw new Error("sign-in preflight failed");
  }
  const { retryAfter, credential } = first.value.value;
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
  keys: readonly string[],
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
    const token = deps.newSessionToken();
    const expiresAtMs = nowMs + SESSION_LIFETIME_MS;
    ports.attempts.clear(request.accountKey);
    ports.sessions.insert({
      sessionId: deps.newSessionId(),
      token,
      ownerId: checked.ownerId,
      createdAtMs: nowMs,
      expiresAtMs,
      ipAddress: request.ip,
      userAgent: request.userAgent,
      assurance: "password",
      passwordVerifiedAtMs: nowMs,
      totpVerifiedAtMs: null,
      accessEpoch,
    });
    ports.audit.append({
      ownerId: checked.ownerId,
      action: "login.succeeded",
      entityId: request.requestId,
      at: new Date(nowMs).toISOString(),
      requestId: request.requestId,
      ...(request.ip === null ? {} : { ip: request.ip }),
      ...(request.userAgent === null ? {} : { userAgent: request.userAgent }),
    });
    return { kind: "granted", token, expiresAtMs, nextAction: "mfa_enrollment" };
  }

  ports.attempts.pruneExpired(nowMs);
  const buckets = keys.map((key) => ({ key, bucket: afterFailure(ports.attempts.find(key), nowMs) }));
  for (const { key, bucket } of buckets) {
    ports.attempts.save(key, bucket);
  }
  const lockedNow = buckets.some(({ bucket }) => bucket.lockedUntilMs !== null);
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
  return lockedNow ? { kind: "locked", retryAfterSeconds: lockedFor(ports, keys, nowMs) ?? 1 } : { kind: "denied" };
}

export type IdentityStatus = Readonly<{ authenticated: boolean; nextAction: NextAction }>;

/** Status from the server state only: the session row, never the cookie alone. */
export function readIdentityStatus(unit: UnitOfWork<SignInPorts>, token: string | null, nowMs: number): IdentityStatus {
  const read = unit.run((ports) => {
    if (token !== null && ports.sessions.findActive(token, nowMs) !== null) {
      return commit<IdentityStatus>({ authenticated: true, nextAction: "mfa_enrollment" });
    }
    return commit<IdentityStatus>({ authenticated: false, nextAction: ports.owners.hasOwner() ? "login" : "create_owner" });
  });
  if (!read.ok) {
    throw new Error("status read failed");
  }
  return read.value.value;
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
