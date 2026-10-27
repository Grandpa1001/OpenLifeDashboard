// Ports of the registries module (Architektura §13.2, §18): the catalog of registries and the
// physical table of each. One adapter implements them on the handle of a unit of work, so the rows
// of the catalog and the `CREATE TABLE` of a new registry commit or roll back together.
import type { NewColumn, NewRegistry } from "./domain/definition.js";

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
