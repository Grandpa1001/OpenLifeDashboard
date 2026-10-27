// The persistent failure buckets shared by every refusal that counts (Architektura §9.8): the
// password at sign-in and the second factor. A request is blocked while either of its two
// buckets (account and IP) is locked, and a blocked request writes nothing, so it cannot extend
// the lock. A counted failure is a committed outcome: the counters and the audit entry must
// survive the 401/429, which is why callers record it in a unit that commits, not in a fault.
import { afterFailure, retryAfterSeconds } from "../domain/lockout.js";
import type { AuthAttemptStore } from "../ports.js";

/** The two buckets a kind of attempt counts in: the account's and the client address's. */
export type BucketKeys = Readonly<{ account: string; ip: string }>;

type Ports = Readonly<{ attempts: AuthAttemptStore }>;

/** The longest remaining lock of the two buckets in seconds, or null if neither is locked. */
export function lockedFor(ports: Ports, keys: BucketKeys, nowMs: number): number | null {
  const remaining = [keys.account, keys.ip].map((key) => retryAfterSeconds(ports.attempts.find(key), nowMs)).filter((seconds): seconds is number => seconds !== null);
  return remaining.length === 0 ? null : Math.max(...remaining);
}

/**
 * Counts one failure in both buckets. The caller has checked that neither is locked in this very
 * unit; the failure that reaches the limit sets the lock. Returns the seconds of a lock set now.
 */
export function registerFailure(ports: Ports, keys: BucketKeys, nowMs: number): number | null {
  ports.attempts.pruneExpired(nowMs);
  for (const key of [keys.account, keys.ip]) {
    ports.attempts.save(key, afterFailure(ports.attempts.find(key), nowMs));
  }
  return lockedFor(ports, keys, nowMs);
}

/** A success clears the account's bucket only: failures of the address from other attempts stay counted. */
export function clearAccountBucket(ports: Ports, keys: BucketKeys): void {
  ports.attempts.clear(keys.account);
}
