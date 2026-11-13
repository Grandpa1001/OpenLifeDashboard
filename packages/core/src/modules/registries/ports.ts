// Ports of the registries module (Architektura §13.2, §18): the catalog of registries and the
// physical table of each. One adapter implements them on the handle of a unit of work, so the rows
// of the catalog and the `CREATE TABLE` of a new registry commit or roll back together.
import type { CellValue } from "./domain/column-rules.js";
import type { NewColumn, NewRegistry } from "./domain/definition.js";
import type { SortColumn, SortDirection } from "./domain/record-rules.js";
import type { PlanClaims } from "./domain/structure-change.js";
import type { CellRewrite } from "./domain/type-change.js";
import type { SystemRow, SystemTableName } from "./domain/system-tables.js";

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
  /**
   * Writes the new definition of one column and raises the schema revision, only while the registry
   * still has the revision it was read with; anything else is a bug upstream and throws, so the whole
   * unit (the rebuilt table among it) is taken back.
   */
  changeColumn(registry: StoredRegistry, column: StoredColumn, nowIso: string): void;
  /** Adds a column to the catalog (D28.1); the same guard on the schema revision, which it raises. */
  addColumn(registry: StoredRegistry, column: StoredColumn, nowIso: string): void;
  /** Gives an active column another display name; the same guard. */
  renameColumn(registry: StoredRegistry, columnId: string, displayName: string, nowIso: string): void;
  /** Marks an active column removed; its row stays, so a binding to it is broken, and its symbol is free again. The same guard. */
  removeColumn(registry: StoredRegistry, columnId: string, nowIso: string): void;
  /**
   * Marks the registry deleted (D30.1): `deleted_at`, the schema revision raised, the same guard. Its
   * rows and those of its columns stay, so its symbol stays taken and a binding to it is broken.
   */
  markDeleted(registry: StoredRegistry, nowIso: string): void;
  /** Takes the deletion back (D30.2): `deleted_at` cleared, the schema and data revisions raised, only while it is deleted at the revision it was read with. */
  markRestored(registry: StoredRegistry, nowIso: string): void;
}

/** A record as it is stored and returned: values by the symbols of the columns, in canonical form. */
export type StoredRecord = Readonly<{
  id: string;
  registryId: string;
  ownerId: string;
  /** Starts at 1; raised on every change (D23.1). */
  revision: number;
  createdAt: string;
  updatedAt: string;
  values: Readonly<Record<string, CellValue>>;
}>;

export type RecordPageQuery = Readonly<{
  sort: SortColumn;
  direction: SortDirection;
  page: number;
  pageSize: number;
  /** A fragment looked for in the textual columns, letter case aside; null lists every record. Checked by `resolveSearch`. */
  search: string | null;
}>;
export type RecordPage = Readonly<{ records: readonly StoredRecord[]; total: number }>;

/**
 * The records of registries. The registry is the catalog's own object, so every identifier of a
 * statement comes from it and never from a request. A write raises the registry's `dataRevision` in
 * the same unit of work; a list returns a page and the count from one consistent read.
 */
export interface RecordStore {
  insert(registry: StoredRegistry, record: StoredRecord): void;
  find(registry: StoredRegistry, recordId: string): StoredRecord | null;
  /** Writes the record over the stored one only while that one still has `expectedRevision`; false when it has not, and nothing is written. */
  replaceIfRevision(registry: StoredRegistry, record: StoredRecord, expectedRevision: number): boolean;
  /** Deletes the record only while it still has `expectedRevision`; false when it has not or is gone, and nothing is deleted. */
  deleteIfRevision(registry: StoredRegistry, recordId: string, expectedRevision: number): boolean;
  /** Sorted by the requested column, then by `id` in the same direction; empty values last. The count is of the records the search matches. */
  page(registry: StoredRegistry, query: RecordPageQuery): RecordPage;
  /**
   * The next `limit` records in the order of their identifiers, those after `afterId` (all from the first when it is null). A scan that reads a
   * whole registry page by page, such as the export (D45.2), costs the same for the last page as for the first.
   */
  pageAfter(registry: StoredRegistry, afterId: string | null, limit: number): readonly StoredRecord[];
  /** The number of records of the registry. */
  count(registry: StoredRegistry): number;
  /** How many records have a value in the column and how many have none. */
  columnFacts(registry: StoredRegistry, columnSymbol: string): Readonly<{ values: number; empty: number }>;
  /**
   * The values of one column of every record, in canonical form, read one row at a time so a large
   * registry is never held in memory. Consumed whole before the next statement of the unit.
   */
  columnValues(registry: StoredRegistry, columnSymbol: string): Iterable<CellValue>;
}

export type IdempotencyEntry = Readonly<{ requestHash: string; response: StoredRecord }>;

/** Keys of operations that must not run twice (Architektura §4.6): bound to the owner, the operation and a hash of the input. */
export interface IdempotencyStore {
  /** The entry that has not expired at `nowIso`, or null. */
  find(ownerId: string, operation: string, key: string, nowIso: string): IdempotencyEntry | null;
  put(entry: Readonly<{ ownerId: string; operation: string; key: string; requestHash: string; response: StoredRecord; createdAt: string; expiresAt: string }>): void;
}

/**
 * What the registries need of the dictionaries (Architektura §13.4: `DictionaryLabels`), declared
 * by the registries so that the two modules do not import each other: which dictionaries a column
 * may name, and the labels of the symbols a page holds. A symbol the dictionary does not have has no
 * label; a hidden value keeps its label (Scope §5.8).
 */
export interface DictionaryLookup {
  ids(ownerId: string): ReadonlySet<string>;
  labels(ownerId: string, dictionaryId: string, symbols: readonly string[]): ReadonlyMap<string, string>;
}

/** A widget of the owner's screens that a change of the structure would touch, and the slots it binds there. */
export type DependentWidget = Readonly<{ screenId: string; screenName: string; widgetId: string; /** The title of its configuration; null when it has none. */ title: string | null; slots: readonly string[] }>;

/**
 * What the registries need of the dashboard (Architektura §13.4): the widgets bound to a registry or
 * to one of its columns, by permanent identifier. Declared here and implemented by the adapter of the
 * dashboard, so the SQL of bindings stays there and the two modules do not import each other.
 */
export interface DependentWidgets {
  /** Widgets bound to the column, or to anything of the registry when `columnId` is null; in the order of their screens and positions. */
  of(ownerId: string, registryId: string, columnId: string | null): readonly DependentWidget[];
  /** How many widgets of the owner each registry has bound to anything of it, in one read; a registry with none is absent (D32.2). */
  countByRegistry(ownerId: string): ReadonlyMap<string, number>;
}

/**
 * The signature of a plan (Architektura §5.2, §14.4): a token that states its claims and is bound to
 * the owner and the change without stating them. Only this installation can issue one.
 */
export interface PlanSigner {
  issue(claims: PlanClaims, binding: Readonly<{ ownerId: string; change: string }>): string;
  /** The claims of a token this installation issued for exactly this owner and change; null for any other token. */
  open(token: string, binding: Readonly<{ ownerId: string; change: string }>): PlanClaims | null;
}

/** The column whose values a rebuild rewrites, and what each value becomes. */
export type RebuiltColumn = Readonly<{ symbol: string; rewrite: (value: CellValue) => CellRewrite }>;

/**
 * The rebuild of a registry's table in the unit of work of the writer (Architektura §4.5, §5.2;
 * D27.1): a new table of the target columns, every row copied with its identifier, owner, times and
 * revision and the one column rewritten, the count checked, the old table replaced by the new one
 * under its name, and its indexes made again. Any failure throws and the unit takes everything back.
 */
export interface TableRebuild {
  rebuild(registry: StoredRegistry, columns: readonly StoredColumn[], changed: RebuiltColumn): Readonly<{ rows: number; failed: number }>;
}

/**
 * The DDL of one column of a registry's table in the unit of work of the writer (Architektura §5.2;
 * D28.1). The column comes from the catalog, never from a request; any failure throws and the unit
 * takes everything back.
 */
/** One stored row of a registry's table as SQLite holds it: the engine columns and the cells, already encoded. */
export type StoredRow = Readonly<Record<string, string | number | null>>;

/** The table of a registry as a whole: what a deletion drops (D30.1) and a restore creates again (D30.2). */
export interface RegistryTables {
  drop(registry: StoredRegistry): void;
  /** Creates the table and its indexes from the definition and inserts the rows page by page, as stored; the count of rows. */
  restore(registry: StoredRegistry, pages: Iterable<readonly StoredRow[]>): number;
}

export interface TableColumns {
  /** Adds the column (and its index, for a date), and writes `fill` into every record there is when it is not null; the number of records written. */
  add(registry: StoredRegistry, column: StoredColumn, fill: CellValue): number;
  /** Drops the index of the column, if it has one, and the column with its values. */
  remove(registry: StoredRegistry, column: StoredColumn): void;
  /** Writes `value` into every cell of the column that `isEmpty` says is empty; the number of cells written. */
  fillEmpty(registry: StoredRegistry, column: StoredColumn, value: CellValue, isEmpty: (value: CellValue) => boolean): number;
}

/**
 * The tables of the system preview (D32.1), each read by the adapter of the module that owns it
 * (Architektura §13.4) and put together by the composition. The rows of `ownerId` only, where a table
 * belongs to an owner; in a fixed order, with the columns of `SYSTEM_TABLES` in their order.
 */
export interface SystemTableReader {
  count(ownerId: string, table: SystemTableName): number;
  page(ownerId: string, table: SystemTableName, offset: number, limit: number): readonly SystemRow[];
}

/** One table of the preview as the adapter of its owning module reads it; the composition puts six of them together. */
export type SystemTableSource = Readonly<{
  count(ownerId: string): number;
  page(ownerId: string, offset: number, limit: number): readonly SystemRow[];
}>;
