// Timing of the live stream in the browser (Architektura §10; D37): fixed in the MVP, not options.
import { STREAM_PING_INTERVAL_MS } from "@openlife/contracts/http/stream";

/** The wait before each next attempt to connect, the last one repeated; a tab that comes back or goes online does not wait. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Slack on top of the ping interval before silence counts: a late ping is not yet a lost stream. */
const SILENCE_GRACE_MS = 5_000;
/** A stream that says nothing for two pings and the slack is taken for dead (a dropped network leaves no error behind). */
export const STREAM_SILENCE_LIMIT_MS = 2 * STREAM_PING_INTERVAL_MS + SILENCE_GRACE_MS;
/** A tab that comes back to a stream quiet for longer than a ping and the slack connects again, as the sleep may have cut it. */
export const RESUME_QUIET_LIMIT_MS = STREAM_PING_INTERVAL_MS + SILENCE_GRACE_MS;
