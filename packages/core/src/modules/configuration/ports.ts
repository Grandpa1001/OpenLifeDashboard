// Ports of the configuration module (Architektura §13.4, §18): its own table, what it needs to know
// of the bindings of the dashboard, and the reader other modules use for `Field.Config.<symbol>`.
// One adapter of each runs on the handle of a unit of work, so an entry and its audit entry commit
// together.
import type { ConfigContent } from "./domain/rules.js";

export type StoredConfigEntry = ConfigContent &
  Readonly<{
    id: string;
    ownerId: string;
    symbol: string;
    /** Starts at 1; raised by every save. */
    revision: number;
    createdAt: string;
    updatedAt: string;
  }>;

export type NewConfigEntryRecord = Readonly<{ id: string; ownerId: string; symbol: string; content: ConfigContent; nowIso: string }>;

export interface ConfigStore {
  count(ownerId: string): number;
  takenSymbols(ownerId: string): ReadonlySet<string>;
  insert(record: NewConfigEntryRecord): void;
  find(ownerId: string, symbol: string): StoredConfigEntry | null;
  /** In the order they were created. */
  list(ownerId: string): readonly StoredConfigEntry[];
  /** Writes the content only while the entry still has `expectedRevision`, and raises it by one; false when it has not, and nothing is written. */
  replaceIfRevision(entry: StoredConfigEntry, content: ConfigContent, expectedRevision: number, nowIso: string): boolean;
  /** Deletes the entry only while it still has `expectedRevision`; false otherwise. */
  deleteIfRevision(entry: StoredConfigEntry, expectedRevision: number): boolean;
}

/** How many bindings of the owner's widgets point at each entry, by its identifier; an entry with none is absent. */
export interface ConfigBindingCounts {
  counts(ownerId: string): ReadonlyMap<string, number>;
}

/**
 * `Field.Config.<symbol>` for the modules that read it (Architektura §5.3, §13.4): the value of an
 * entry of the owner, always text, or null when the owner has no such entry.
 */
export interface ConfigReader {
  entry(ownerId: string, entryId: string): Readonly<{ symbol: string; value: string }> | null;
}
