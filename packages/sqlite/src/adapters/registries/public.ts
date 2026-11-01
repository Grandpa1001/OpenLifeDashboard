// Public API of the registries adapter (Architektura §13.3): the store of the catalog, the DDL of
// the tables of registries and the columns that use a dictionary.
export { bindRegistryStore } from "./registry-store.js";
export { UnsafeIdentifierError, quoteIdentifier, registryDdl } from "./registry-ddl.js";
export type { RegistryDdl } from "./registry-ddl.js";
export { bindRecordStore } from "./record-store.js";
export { bindIdempotencyStore } from "./idempotency-store.js";
export { bindColumnDictionaryLinks } from "./column-links.js";
