// The time an update may take on the side of the app (Architektura §11.2.2; D54.4): constants of the protocol between the
// app and the updater, not options of the owner. They bound every wait so that an update that does not move gives up and
// says so instead of holding the installation.
/** How often the app asks the updater where the operation is while the updater pulls. */
export const UPDATE_STATUS_POLL_MS = 1000;
/** How long the pull of the images of a release may take before the app stops waiting for it. */
export const UPDATE_PULL_TIMEOUT_MS = 30 * 60 * 1000;
/** How long the writes already taken may take to end once the app is closed for new ones. */
export const UPDATE_DRAIN_TIMEOUT_MS = 30 * 1000;
/** One request to the updater. */
export const UPDATER_REQUEST_TIMEOUT_MS = 10 * 1000;
/** A command whose answer was lost is sent again (with a new nonce, the same operation) up to this many times. */
export const UPDATER_SEND_ATTEMPTS = 3;
