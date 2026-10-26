// Session constants (Architektura §14.4): fixed in the MVP, not options.

/** A session lives 30 days; renewal on use is added with the session list (D43). */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
