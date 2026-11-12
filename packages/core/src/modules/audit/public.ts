// Public API of the audit module (Architektura §13.2, §18.1).
export { pruneAuditLog } from "./application/prune-audit-log.js";
export type { AuditPruneDependencies, AuditPruneInput, AuditPrunePorts, AuditPruned } from "./application/prune-audit-log.js";
export type { AppendAudit, AuditRetention, AuditDetails, AuditEntry, AuditLogReader, AuditPage, AuditQuery, AuditRecord } from "./ports.js";
export { AUDIT_KINDS, AUDIT_KIND_FILTERS, auditKindOf } from "./domain/audit-kinds.js";
export type { AuditKind, AuditKindFilter } from "./domain/audit-kinds.js";
