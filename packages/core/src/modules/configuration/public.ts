// Public API of the configuration module (Architektura §13.2, §13.4, §18; D25.1): the rules of an
// entry of ConfigTable, its ports, its use cases and the values of `Field.System`. The dashboard
// never imports it; it learns the symbol of an entry through its own catalog port.
export { DEFAULT_CONFIG_LIMITS, validateConfigContent, validateNewConfigEntry } from "./domain/rules.js";
export type { ConfigContent, ConfigIssue, ConfigIssueCode, ConfigLimits, ConfigRulesResult, NewConfigEntry } from "./domain/rules.js";
export { SYSTEM_FIELD_SYMBOLS, systemFieldValue } from "./domain/system-fields.js";
export type { SystemFieldContext, SystemFieldSymbol } from "./domain/system-fields.js";
export type { ConfigBindingCounts, ConfigReader, ConfigStore, NewConfigEntryRecord, StoredConfigEntry } from "./ports.js";
export { createConfigEntry, deleteConfigEntry, getConfigEntry, listConfigEntries, saveConfigEntry } from "./application/config-entries.js";
export type { ConfigDependencies, ConfigEntryOverview, ConfigPorts, ConfigSave } from "./application/config-entries.js";
