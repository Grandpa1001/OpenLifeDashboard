// The rules of the autosave of the Designer (Scope §5.4, Architektura §7.2, §18.5; D35.1): when a
// design is sent, what a failure means and how long to wait before trying again. Pure, so the hook
// that runs them and the tests share one rule.
import type { ApiFailure } from "../../../lib/api-client/request.js";

/** No change for this long sends the design (Scope §5.4). */
export const AUTOSAVE_DEBOUNCE_MS = 1000;
/** The waits before the next try after a failure, then the last one again (Scope §5.4 "rosnący odstęp"). */
export const RETRY_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
/** At most this share of a wait is added at random, so tabs that lost the network together do not come back together. */
export const RETRY_JITTER = 0.2;

/** The wait before try number `attempt` (0 for the first retry); `random` is a number in [0, 1). */
export function retryDelay(attempt: number, random: number): number {
  const base = RETRY_STEPS_MS[Math.min(Math.max(attempt, 0), RETRY_STEPS_MS.length - 1)]!;
  return Math.round(base * (1 + RETRY_JITTER * Math.min(Math.max(random, 0), 1)));
}

/** What a failed save means: no network, a server that may answer later, a design it refused, or a session that no longer reaches the screen. */
export type SaveTrouble = "offline" | "retrying" | "refused" | "gate";

export function troubleOf(failure: Exclude<ApiFailure, { kind: "aborted" }>): SaveTrouble {
  if (failure.kind === "network") return "offline";
  if (failure.kind === "invalid-response") return "retrying";
  if (failure.status === 401 || failure.status === 403) return "gate";
  // A refusal is the same for the same design: it is told and tried again with the next change, not in a loop.
  if (failure.status >= 400 && failure.status < 500 && failure.status !== 408 && failure.status !== 429) return "refused";
  return "retrying";
}

/** The state of the saving the bar shows (makieta 29). */
export type SaveState =
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "saving" }>
  | Readonly<{ kind: "saved"; at: number }>
  | Readonly<{ kind: "retrying" }>
  | Readonly<{ kind: "offline" }>
  | Readonly<{ kind: "refused"; failure: Exclude<ApiFailure, { kind: "aborted" }> }>;
