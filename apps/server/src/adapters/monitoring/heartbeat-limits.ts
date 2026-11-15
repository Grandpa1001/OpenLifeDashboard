// Protocol constants of the backup heartbeat (Architektura §11.3.2; D49.4). They are security parameters of
// the one outgoing request the application makes for the monitoring, not options of the owner.

/** The whole signal (name resolution, connection, answer) ends within this time; a slow monitor never holds the job. */
export const HEARTBEAT_TIMEOUT_MS = 10 * 1000;

/** The longest address accepted from the environment. */
export const HEARTBEAT_URL_MAX_LENGTH = 2048;
