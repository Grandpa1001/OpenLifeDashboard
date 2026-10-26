// Persistent password lockout policy (Architektura §9.8): five failures within a 15-minute window
// lock a bucket for 15 minutes. Pure functions over a stored bucket and an injected clock.

export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export type LockoutBucket = Readonly<{
  failures: number;
  windowStartedAtMs: number;
  lockedUntilMs: number | null;
}>;

/** Whole seconds left of a lock, rounded up (Retry-After); null when not locked. At lockedUntil the bucket is open again. */
export function retryAfterSeconds(bucket: LockoutBucket | null, nowMs: number): number | null {
  if (bucket === null || bucket.lockedUntilMs === null || nowMs >= bucket.lockedUntilMs) {
    return null;
  }
  return Math.ceil((bucket.lockedUntilMs - nowMs) / 1000);
}

/**
 * The bucket after one more failure. A finished lock or an expired window starts a new count;
 * the failure that reaches the limit sets the lock. Calling it for a bucket that is still locked
 * is a programming error: blocked requests must not extend a lock.
 */
export function afterFailure(bucket: LockoutBucket | null, nowMs: number): LockoutBucket {
  if (retryAfterSeconds(bucket, nowMs) !== null) {
    throw new RangeError("a locked bucket must not be extended");
  }
  const fresh = bucket === null || bucket.lockedUntilMs !== null || nowMs - bucket.windowStartedAtMs >= LOCKOUT_WINDOW_MS;
  const failures = fresh ? 1 : bucket.failures + 1;
  return {
    failures,
    windowStartedAtMs: fresh ? nowMs : bucket.windowStartedAtMs,
    lockedUntilMs: failures >= LOCKOUT_MAX_FAILURES ? nowMs + LOCKOUT_DURATION_MS : null,
  };
}

/** A bucket that holds no information any more: its window ended and it is not locked. */
export function isExpired(bucket: LockoutBucket, nowMs: number): boolean {
  return retryAfterSeconds(bucket, nowMs) === null && nowMs - bucket.windowStartedAtMs >= LOCKOUT_WINDOW_MS;
}
