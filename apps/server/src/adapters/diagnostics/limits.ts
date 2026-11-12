// Protocol constants of the diagnostics (Architektura §15.3; D44). They bound the work one read does; they
// are not options of the owner.

/** The latest technical errors the overview shows. */
export const RECENT_ERRORS_MAX = 10;

/** How much of the end of the active log is read to find them; the log is never read whole for an overview. */
export const RECENT_ERRORS_TAIL_BYTES = 256 * 1024;
