// What the updater may say in its log (Architektura §15; D52.5): an event and a code, never a token, a signature or a body.
export type UpdaterLogEvent = Readonly<{ level: "info" | "warn" | "error"; event: string; code?: string; operationId?: string }>;
export type UpdaterLogger = Readonly<{ log: (event: UpdaterLogEvent) => void }>;
