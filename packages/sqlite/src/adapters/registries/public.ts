// Public API of the registries adapter (Architektura §13.3): the store of the catalog, the DDL of
// the tables of registries, the columns that use a dictionary, the rebuild of a table and the DDL of one column.
export { bindRegistryStore } from "./registry-store.js";
export { UnsafeIdentifierError, indexNameOf, quoteIdentifier, registryDdl, registryTableSql } from "./registry-ddl.js";
export type { RegistryDdl } from "./registry-ddl.js";
export { bindRecordStore } from "./record-store.js";
export { bindIdempotencyStore } from "./idempotency-store.js";
export { bindColumnDictionaryLinks } from "./column-links.js";
export { bindTableRebuild, REBUILD_PAGE_ROWS, REBUILD_TABLE_SUFFIX } from "./table-rebuild.js";
export { readRebuildOutcome } from "./rebuild-outcome.js";
export { bindTableColumns } from "./table-columns.js";
export type { RebuildOutcome } from "./rebuild-outcome.js";
