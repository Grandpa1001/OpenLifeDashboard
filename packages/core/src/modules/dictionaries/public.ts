// Public API of the dictionaries module (Architektura §13.2, §13.4, §18; D24.1): the rules of a
// dictionary, its ports and its use cases. The registries never import it; they read labels through
// their own port (`DictionaryLookup`), which the adapter of this module's tables implements.
export { DEFAULT_DICTIONARY_LIMITS, validateDictionaryContent, validateNewDictionary, valueChanges } from "./domain/rules.js";
export type { DictionaryContent, DictionaryIssue, DictionaryIssueCode, DictionaryLimits, DictionaryRulesResult, DictionaryValue, NewDictionary } from "./domain/rules.js";
export type { ColumnDictionaryLinks, DictionaryStore, DictionaryUsage, NewDictionaryRecord, StoredDictionary, StoredDictionaryValue } from "./ports.js";
export { createDictionary, deleteDictionary, getDictionary, listDictionaries, saveDictionary } from "./application/dictionaries.js";
export type { DictionaryDependencies, DictionaryOverview, DictionaryPorts, DictionarySave } from "./application/dictionaries.js";
