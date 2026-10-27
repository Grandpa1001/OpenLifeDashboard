// Public API of the registries module (Architektura §13.2, §18): the rules of the catalog that
// need no database. The use case and the ports of the catalog join with the adapter (D14.2–D14.3).
export { COLUMN_TYPES, DECIMAL_PLACES_MAX, isColumnType, isValidDefault, normalizeTypeOptions } from "./domain/column-rules.js";
export type { CellValue, ColumnType, ColumnTypeOptions } from "./domain/column-rules.js";
export { validateNewRegistry } from "./domain/definition.js";
export type { ColumnDraft, DefinitionResult, NewColumn, NewRegistry, RegistryContext, RegistryDraft, RegistryIssue, RegistryIssueCode } from "./domain/definition.js";
export { DEFAULT_REGISTRY_LIMITS, DISPLAY_NAME_MAX_CHARS } from "./domain/limits.js";
export type { RegistryLimits } from "./domain/limits.js";
export { RESERVED_COLUMN_SYMBOLS } from "./domain/sql-keywords.js";
export { SYMBOL_MAX_LENGTH, SYMBOL_PATTERN, checkSymbol, suggestSymbol } from "./domain/symbols.js";
export type { SymbolIssue, SymbolSpace } from "./domain/symbols.js";
