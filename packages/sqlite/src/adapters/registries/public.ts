// Public API of the registries adapter (Architektura §13.3): the store of the catalog and the
// DDL of the tables of registries.
export { bindRegistryStore } from "./registry-store.js";
export { UnsafeIdentifierError, quoteIdentifier, registryDdl } from "./registry-ddl.js";
export type { RegistryDdl } from "./registry-ddl.js";
