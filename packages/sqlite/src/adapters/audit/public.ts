// Public API of the audit adapter (Architektura §13.3): the append of an entry, the reading of the trail for
// the Security page, and the audit log as a table of the system preview.
export { bindAppendAudit } from "./append-audit.js";
export { bindAuditLogReader } from "./audit-log-reader.js";
export { bindAuditSystemTables } from "./system-tables.js";
