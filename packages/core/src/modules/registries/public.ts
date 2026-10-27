// Public API of the registries module (Architektura §13.2, §18): the rules of the catalog that
// need no database. The ports of the catalog are here (D14.2); the use case joins with the route (D14.3).
export { COLUMN_TYPES, DECIMAL_PLACES_MAX, isColumnType, isValidDefault, normalizeTypeOptions } from "./domain/column-rules.js";
export type { CellValue, ColumnType, ColumnTypeOptions } from "./domain/column-rules.js";
export { validateNewRegistry } from "./domain/definition.js";
export type { ColumnDraft, DefinitionResult, NewColumn, NewRegistry, RegistryContext, RegistryDraft, RegistryIssue, RegistryIssueCode } from "./domain/definition.js";
export { DEFAULT_REGISTRY_LIMITS, DISPLAY_NAME_MAX_CHARS } from "./domain/limits.js";
export type { RegistryLimits } from "./domain/limits.js";
export { RESERVED_COLUMN_SYMBOLS } from "./domain/sql-keywords.js";
export { REGISTRY_TABLE_PREFIX, SYMBOL_MAX_LENGTH, SYMBOL_PATTERN, checkSymbol, suggestSymbol, tableNameOf } from "./domain/symbols.js";
export type { SymbolIssue, SymbolSpace } from "./domain/symbols.js";
export { createRegistry, listRegistries } from "./application/create-registry.js";
export type { RegistryDependencies, RegistryPorts } from "./application/create-registry.js";
export type { NewRegistryRecord, RegistryStore, StoredColumn, StoredRegistry } from "./ports.js";
