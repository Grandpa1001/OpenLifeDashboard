// The nonces the updater has seen (Architektura §11.2.1): a command is accepted once. A nonce is remembered for
// twice the clock skew, as long as a command with it could still pass the check of its time, and then forgotten;
// the table is bounded and a full one refuses new commands rather than forget a nonce that could still be
// replayed (fail closed).
export type ReplayCache = Readonly<{
  /** True when the nonce is new and now remembered; false when it was seen; "full" when the table cannot take another. */
  remember: (nonce: string, nowMs: number) => boolean | "full";
}>;

export function createReplayCache(options: Readonly<{ windowMs: number; maxEntries: number }>): ReplayCache {
  const seen = new Map<string, number>();
  return {
    remember: (nonce, nowMs) => {
      for (const [other, expiresAt] of seen) {
        if (expiresAt > nowMs) break;
        seen.delete(other);
      }
      if (seen.has(nonce)) return false;
      if (seen.size >= options.maxEntries) return "full";
      seen.set(nonce, nowMs + options.windowMs);
      return true;
    },
  };
}
