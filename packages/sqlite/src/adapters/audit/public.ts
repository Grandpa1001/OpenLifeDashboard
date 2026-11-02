// Public API of the audit adapter (Architektura §13.3): the append of an entry, and the audit log as a
// table of the system preview.
export { bindAppendAudit } from "./append-audit.js";
export { bindAuditSystemTables } from "./system-tables.js";
