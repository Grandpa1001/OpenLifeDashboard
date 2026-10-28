// Query key factories (Architektura §13.1): one place for the keys of cached server state, so a
// logout can drop exactly the private ones.
export const queryKeys = {
  identity: { status: ["identity", "status"] as const },
  setup: { owner: ["setup", "owner"] as const },
  screens: { list: ["screens", "list"] as const, screen: (id: string) => ["screens", "screen", id] as const, widgetData: (id: string) => ["screens", "widget-data", id] as const },
  registries: { list: ["registries", "list"] as const, records: (symbol: string) => ["registries", "records", symbol] as const },
} as const;
