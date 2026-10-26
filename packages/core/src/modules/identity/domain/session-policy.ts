// Session constants (Architektura §14.4): fixed in the MVP, not options.

/** A session lives 30 days; renewal on use is added with the session list (D43). */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** A trusted device is valid 30 days from its creation and is never extended by use (Architektura §14.4). */
export const TRUSTED_DEVICE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
