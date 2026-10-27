// Ports of the registries module (Architektura §13.2, §18): the catalog of registries and the
// physical table of each. One adapter implements them on the handle of a unit of work, so the rows
// of the catalog and the `CREATE TABLE` of a new registry commit or roll back together.
import type { CellValue } from "./domain/column-rules.js";
import type { NewColumn, NewRegistry } from "./domain/definition.js";
import type { SortColumn, SortDirection } from "./domain/record-rules.js";

/** What the engine needs to create a registry: the validated definition and the identifiers it was given. */
export type NewRegistryRecord = Readonly<{
  id: string;
  ownerId: string;
  /** One identifier per column of the definition, in its order. */
  columnIds: readonly string[];
  definition: NewRegistry;
  /** UTC, ISO 8601. */
  nowIso: string;
}>;

export type StoredColumn = NewColumn & Readonly<{ id: string }>;

export type StoredRegistry = Readonly<{
  id: string;
  ownerId: string;
  symbol: string;
  displayName: string;
  /** The physical table of the records: `reg_<symbol>`. */
  tableName: string;
  schemaRevision: number;
  dataRevision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  columns: readonly StoredColumn[];
}>;

export interface RegistryStore {
  /** Registries that are not deleted. */
  activeCount(ownerId: string): number;
  /** Symbols of every registry of the owner, deleted ones included. */
  takenSymbols(ownerId: string): ReadonlySet<string>;
  /**
   * Writes the catalog rows and creates the table and its indexes. A symbol that does not pass the
   * rules of the module is refused before any statement is built (the use case has checked it
   * already; this is the last guard before a name becomes an identifier).
   */
  insert(record: NewRegistryRecord): void;
  find(ownerId: string, symbol: string): StoredRegistry | null;
  /** Registries that are not deleted, in the order they were created. */
  list(ownerId: string): readonly StoredRegistry[];
}

/** A record as it is stored and returned: values by the symbols of the columns, in canonical form. */
export type StoredRecord = Readonly<{
  id: string;
  registryId: string;
  ownerId: string;
  /** Starts at 1; raised on every update (D23). */
  revision: number;
  createdAt: string;
  updatedAt: string;
  values: Readonly<Record<string, CellValue>>;
}>;

export type RecordPageQuery = Readonly<{ sort: SortColumn; direction: SortDirection; page: number; pageSize: number }>;
export type RecordPage = Readonly<{ records: readonly StoredRecord[]; total: number }>;

/**
 * The records of registries. The registry is the catalog's own object, so every identifier of a
 * statement comes from it and never from a request. A write raises the registry's `dataRevision` in
 * the same unit of work; a list returns a page and the count from one consistent read.
 */
export interface RecordStore {
  insert(registry: StoredRegistry, record: StoredRecord): void;
  find(registry: StoredRegistry, recordId: string): StoredRecord | null;
  /** Sorted by the requested column, then by `id` in the same direction; empty values last. */
  page(registry: StoredRegistry, query: RecordPageQuery): RecordPage;
}

export type IdempotencyEntry = Readonly<{ requestHash: string; response: StoredRecord }>;

/** Keys of operations that must not run twice (Architektura §4.6): bound to the owner, the operation and a hash of the input. */
export interface IdempotencyStore {
  /** The entry that has not expired at `nowIso`, or null. */
  find(ownerId: string, operation: string, key: string, nowIso: string): IdempotencyEntry | null;
  put(entry: Readonly<{ ownerId: string; operation: string; key: string; requestHash: string; response: StoredRecord; createdAt: string; expiresAt: string }>): void;
}
