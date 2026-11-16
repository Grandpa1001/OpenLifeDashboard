// How often the application asks for the releases and how it behaves when the answer is not one (Architektura §11.1;
// D53.1). Pure: the state and the clock come in, the next state and the time to wait come out. The daily check, the
// backoff after a failure and the rate limit of the API are one policy, and "Check now" is a request that this policy
// may refuse for a short time, never one that overrides the limit of the API.

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** "Check now" twice in this time is one request. */
export const MANUAL_COOLDOWN_MS = 30 * 1000;
export const BACKOFF_BASE_MS = 5 * 60 * 1000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
/** A limit of the API that gives no time is waited out for this long. */
export const RATE_LIMIT_DEFAULT_MS = 60 * 60 * 1000;
export const RATE_LIMIT_MAX_MS = 24 * 60 * 60 * 1000;

export type FailureKind = "network" | "rate_limited" | "server" | "invalid";

export type CheckState = Readonly<{
  failures: number;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  /** Nothing is asked before this time, whatever asks: the limit of the API or the backoff. */
  notBeforeMs: number | null;
  /** True when `notBeforeMs` is the limit of the API, which "Check now" also respects. */
  rateLimited: boolean;
}>;

export const INITIAL_CHECK_STATE: CheckState = { failures: 0, lastAttemptAtMs: null, lastSuccessAtMs: null, notBeforeMs: null, rateLimited: false };

export function afterSuccess(state: CheckState, nowMs: number): CheckState {
  return { ...state, failures: 0, lastAttemptAtMs: nowMs, lastSuccessAtMs: nowMs, notBeforeMs: null, rateLimited: false };
}

/** The wait after the failure number `failures` (1 for the first): doubling from five minutes to six hours; a limit of the API waits for what it says, bounded. */
export function backoffMs(failures: number, kind: FailureKind, retryAfterMs: number | null): number {
  if (kind === "rate_limited") return Math.min(RATE_LIMIT_MAX_MS, Math.max(retryAfterMs ?? RATE_LIMIT_DEFAULT_MS, BACKOFF_BASE_MS));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export function afterFailure(state: CheckState, nowMs: number, kind: FailureKind, retryAfterMs: number | null = null): CheckState {
  const failures = state.failures + 1;
  return { ...state, failures, lastAttemptAtMs: nowMs, notBeforeMs: nowMs + backoffMs(failures, kind, retryAfterMs), rateLimited: kind === "rate_limited" };
}

/** Whether the daily check is due: the day since the last success has passed and no backoff holds it. */
export function dailyCheckDue(state: CheckState, nowMs: number): boolean {
  if (state.notBeforeMs !== null && nowMs < state.notBeforeMs) return false;
  return state.lastSuccessAtMs === null || nowMs - state.lastSuccessAtMs >= CHECK_INTERVAL_MS;
}

export type ManualDecision = Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: "COOLDOWN" | "RATE_LIMITED"; retryAfterMs: number }>;

/** "Check now": refused only while the limit of the API holds and for a short cooldown after an attempt; an ordinary backoff does not stop a person who asks. */
export function manualCheck(state: CheckState, nowMs: number): ManualDecision {
  if (state.rateLimited && state.notBeforeMs !== null && nowMs < state.notBeforeMs) return { allowed: false, reason: "RATE_LIMITED", retryAfterMs: state.notBeforeMs - nowMs };
  if (state.lastAttemptAtMs !== null && nowMs - state.lastAttemptAtMs < MANUAL_COOLDOWN_MS) return { allowed: false, reason: "COOLDOWN", retryAfterMs: MANUAL_COOLDOWN_MS - (nowMs - state.lastAttemptAtMs) };
  return { allowed: true };
}
