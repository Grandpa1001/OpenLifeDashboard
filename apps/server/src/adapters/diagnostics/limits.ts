// Protocol constants of the diagnostics (Architektura §15.3; D44). They bound the work one read does; they
// are not options of the owner.

/** The latest technical errors the overview shows. */
export const RECENT_ERRORS_MAX = 10;

/** How much of the end of the active log is read to find them; the log is never read whole for an overview. */
export const RECENT_ERRORS_TAIL_BYTES = 256 * 1024;

/** The largest log file the diagnostics list, download or search; the sink rotates far below it (logs.fileMaxMiB). */
export const LOG_FILE_MAX_BYTES = 64 * 1024 * 1024;

/** Files listed at most: the sink keeps at most `logs.maxFiles` of them. */
export const LOG_FILES_LISTED_MAX = 100;

/** The lines of one request a search returns. */
export const REQUEST_LOG_MAX_LINES = 100;

/** The bytes one search reads in all, over every file. */
export const REQUEST_LOG_MAX_SCAN_BYTES = 256 * 1024 * 1024;
