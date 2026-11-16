// The time the updater waits for the new app (Architektura §11.2.2 "Timeout startu"; D55.3): a constant of the protocol between
// the app and the updater, not an option. The option of the environment (60 to 900 seconds) and the separation of a slow start from a
// failed migration and from the kill of a process that ran out of memory come with the way back (D56).
/** How long the new app has, from the start of its container, to tell the updater it is ready. */
export const START_TIMEOUT_MS = 180 * 1000;
