// Ports of the audit module (Architektura §4.2, §9.5, §18.1): the security and structure trail,
// distinct from the technical log. An entry is written in the same unit of work as the change it
// records, so a failing append rolls the change back.

export type AuditDetails = Readonly<Record<string, string | number | boolean | null>>;

export type AuditEntry = Readonly<{
  /** The acting owner; null before an owner exists (the entry belongs to the installation). */
  ownerId: string | null;
  /** `<entity>.<event>`, e.g. `owner.created`: the part before the dot names the entity. */
  action: string;
  entityId: string;
  /** ISO-8601 UTC. */
  at: string;
  requestId: string;
  /** Operation type and permitted context only: never a password, token, secret or free text of a foreign login. */
  details?: AuditDetails;
  ip?: string;
  userAgent?: string;
}>;

export interface AppendAudit {
  append(entry: AuditEntry): void;
}

/** One entry of the trail as it is read: the stored facts, with the address and the browser in full. */
export type AuditRecord = Readonly<{
  id: number;
  /** ISO-8601 UTC. */
  at: string;
  action: string;
  entityId: string;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  details: AuditDetails | null;
}>;

export type AuditPage = Readonly<{ entries: readonly AuditRecord[]; total: number }>;

/** The entries to read: a kind filter or all of them, and the window of the page. Newest first. */
export type AuditQuery = Readonly<{
  filter: Readonly<{ entities: readonly string[]; actions: readonly string[]; except: readonly string[] }> | null;
  offset: number;
  limit: number;
}>;

/** Reading the trail. It writes nothing. */
export interface AuditLogReader {
  page(query: AuditQuery): AuditPage;
}
