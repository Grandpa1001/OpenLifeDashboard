// Protocol constants of the live stream (Architektura §9.4, §10; D37): fixed in the MVP, not options.

/** A `ping` every 25 s keeps the stream alive through proxies and tells the server whether the session still holds. */
export const STREAM_PING_INTERVAL_MS = 25_000;
/** Streams one session may hold at once (a tab each; the sixth is refused). */
export const STREAM_CONNECTIONS_PER_SESSION = 5;
/** What a refused sixth stream is told to wait: a tab that closes frees its place at once. */
export const STREAM_RETRY_AFTER_SECONDS = 5;
/** Events one stream may hold unread; a client that falls further behind is ended and reads its data again when it connects. */
export const STREAM_MAX_QUEUED_EVENTS = 64;
