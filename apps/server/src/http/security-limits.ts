// Request limits of the HTTP layer (Architektura §9.4, §14.4): fixed in the MVP, not options.

/** Sign-in requests per client IP per minute. */
export const LOGIN_REQUESTS_PER_MINUTE = 10;
export const LOGIN_LIMIT_WINDOW_MS = 60_000;
/** A sign-in body is a short JSON object; more is refused before it is read. */
export const LOGIN_BODY_MAX_BYTES = 4 * 1024;
/** Longest user-agent kept in a session and an audit entry. */
export const USER_AGENT_MAX_LENGTH = 256;
