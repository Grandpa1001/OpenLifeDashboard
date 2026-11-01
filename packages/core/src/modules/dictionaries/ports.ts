// Ports of the dictionaries module (Architektura §13.4, §18): its own tables, and what it needs of
// the catalog of registries when a dictionary is deleted. One adapter of each runs on the handle of
// a unit of work, so a dictionary, the columns it is unpinned from and the audit entry commit together.
import type { DictionaryContent, DictionaryValue } from "./domain/rules.js";

export type StoredDictionaryValue = DictionaryValue & Readonly<{ id: string; position: number }>;

export type StoredDictionary = Readonly<{
  id: string;
  ownerId: string;
  symbol: string;
  displayName: string;
  /** Starts at 1; raised by every save of the content. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** In their order. */
  values: readonly StoredDictionaryValue[];
}>;

export type NewDictionaryRecord = Readonly<{
  id: string;
  ownerId: string;
  symbol: string;
  content: DictionaryContent;
  /** One identifier per value, in their order. */
  valueIds: readonly string[];
  nowIso: string;
}>;

export interface DictionaryStore {
  count(ownerId: string): number;
  takenSymbols(ownerId: string): ReadonlySet<string>;
  insert(record: NewDictionaryRecord): void;
  find(ownerId: string, symbol: string): StoredDictionary | null;
  /** In the order they were created. */
  list(ownerId: string): readonly StoredDictionary[];
  /**
   * Writes the content over the stored one only while the dictionary still has `expectedRevision`,
   * and raises it by one; false when it has not, and nothing is written. A value keeps its
   * identifier by its symbol; `newId` gives one to a symbol that is new.
   */
  replaceIfRevision(dictionary: StoredDictionary, content: DictionaryContent, expectedRevision: number, newId: () => string, nowIso: string): boolean;
  /** Deletes the dictionary and its values only while it still has `expectedRevision`; false otherwise. */
  deleteIfRevision(dictionary: StoredDictionary, expectedRevision: number): boolean;
}

/** A column of a registry that shows its values through a dictionary. */
export type DictionaryUsage = Readonly<{ dictionaryId: string; registrySymbol: string; registryName: string; columnSymbol: string; columnName: string }>;

/**
 * What the dictionaries need of the catalog of registries (Architektura §5.2, §13.4): which columns
 * use a dictionary, and to unpin them when it is deleted. Unpinning keeps the type "choice" and every
 * value; it raises the schema revision of each registry it touches, so a form built before reloads.
 */
export interface ColumnDictionaryLinks {
  usages(ownerId: string): readonly DictionaryUsage[];
  unpin(ownerId: string, dictionaryId: string, nowIso: string): readonly DictionaryUsage[];
}
