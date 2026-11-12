// Query key factories (Architektura §13.1): one place for the keys of cached server state, so a
// logout can drop exactly the private ones.
export const queryKeys = {
  identity: { status: ["identity", "status"] as const },
  setup: { owner: ["setup", "owner"] as const },
  screens: { list: ["screens", "list"] as const, screen: (id: string) => ["screens", "screen", id] as const, widgetData: (id: string) => ["screens", "widget-data", id] as const, allWidgetData: ["screens", "widget-data"] as const, widgetTypes: ["screens", "widget-types"] as const },
  registries: { list: ["registries", "list"] as const, records: (symbol: string) => ["registries", "records", symbol] as const, allRecords: ["registries", "records"] as const, summaries: ["registries", "summaries"] as const },
  systemTables: { list: ["system-tables", "list"] as const, page: (name: string, page: number) => ["system-tables", "page", name, page] as const },
  dictionaries: { list: ["dictionaries", "list"] as const },
  config: { list: ["config", "list"] as const },
  appSettings: { list: ["app-settings", "list"] as const },
  diagnostics: { overview: ["diagnostics", "overview"] as const, logFiles: ["diagnostics", "log-files"] as const },
  security: {
    sessions: ["security", "sessions"] as const,
    devices: ["security", "devices"] as const,
    factor: ["security", "factor"] as const,
    audit: (kind: string, page: number) => ["security", "audit", kind, page] as const,
    allAudit: ["security", "audit"] as const,
  },
} as const;
