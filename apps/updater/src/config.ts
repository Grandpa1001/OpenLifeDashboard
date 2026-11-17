// The options of the updater that come from its environment (Architektura §11.2.2, §14; D56.2). One is an option of the installation, set by
// the administrator and never by a request: how long the new app has, from the start of its container, to prove itself. Unset means the
// constant of the protocol (180 seconds); a value that is not a whole number of seconds in the range is refused at the start of the
// updater, which then does not start (the same as a token that is not of the right shape), and nothing of the value is printed.
import { START_TIMEOUT_MAX_SECONDS, START_TIMEOUT_MIN_SECONDS, START_TIMEOUT_MS } from "./install/update-limits.js";

export const START_TIMEOUT_ENV = "UPDATER_START_TIMEOUT_SECONDS";

export function startTimeoutOf(env: Readonly<Record<string, string | undefined>>): Readonly<{ ok: true; ms: number }> | Readonly<{ ok: false }> {
  const raw = env[START_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return { ok: true, ms: START_TIMEOUT_MS };
  if (!/^\d{1,4}$/.test(raw)) return { ok: false };
  const seconds = Number(raw);
  return seconds >= START_TIMEOUT_MIN_SECONDS && seconds <= START_TIMEOUT_MAX_SECONDS ? { ok: true, ms: seconds * 1000 } : { ok: false };
}
