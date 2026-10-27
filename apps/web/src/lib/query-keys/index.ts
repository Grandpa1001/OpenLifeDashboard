// Query key factories (Architektura §13.1): one place for the keys of cached server state, so a
// logout can drop exactly the private ones.
export const queryKeys = {
  identity: { status: ["identity", "status"] as const },
  setup: { owner: ["setup", "owner"] as const },
} as const;
