// Protocol constants of the technical log (Architektura §15.2, "Granice od D06"). They are fixed
// by the contract, not options: the rotation limits the owner may change are in the settings
// catalog (logs.*).

/** A finished line (UTF-8, newline included) above this never reaches a file or the queue. */
export const MAX_LOG_LINE_BYTES = 16 * 1024;

/** Lines waiting for the file; beyond it new lines are counted as lost instead of buffered. */
export const LOG_QUEUE_LIMIT_BYTES = 1024 * 1024;

/** A degraded sink reports to stderr at most this often, and never through the log itself. */
export const LOG_NOTICE_INTERVAL_MS = 60_000;

/** A sink whose file failed tries to open it again no sooner than this. */
export const LOG_REOPEN_INTERVAL_MS = 30_000;

/** How often rotated files are checked against the retention age, besides at each rotation. */
export const LOG_RETENTION_SWEEP_MS = 60 * 60 * 1000;
