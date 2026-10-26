// The shape of existing tables as SQLite reports it (D09.1): columns with declared type, NOT NULL
// and primary key, single-column unique and plain indexes, and foreign keys. A caller compares it
// with what an adapter expects (Architektura §9.8: a missing auth column blocks readiness). Read
// only: nothing here creates or changes a table.
import type { SqliteConnection } from "../connection/open-database.js";

export type ColumnShape = Readonly<{ name: string; declaredType: string; notNull: boolean; primaryKey: boolean }>;

export type TableShape = Readonly<{
  columns: readonly ColumnShape[];
  /** Columns that are unique on their own (UNIQUE constraint, unique index or primary key). */
  uniqueColumns: readonly string[];
  /** Columns that lead an index of any kind. */
  indexedColumns: readonly string[];
  /** `from` of this table references column `to` of `table`. */
  foreignKeys: readonly Readonly<{ from: string; table: string; to: string }>[];
}>;

type Row = Readonly<Record<string, unknown>>;
type Pragma = "table_info" | "index_list" | "index_info" | "foreign_key_list";

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;

const rows = (connection: SqliteConnection, pragma: Pragma, name: string): Row[] =>
  connection.handle.prepare(`SELECT * FROM pragma_${pragma}(?)`).all(name).filter(isRow);

/** `null` for a table that does not exist. */
export function readTableShape(connection: SqliteConnection, table: string): TableShape | null {
  const columns = rows(connection, "table_info", table).map((row) => ({
    name: String(row["name"]),
    declaredType: String(row["type"]),
    notNull: row["notnull"] === 1,
    primaryKey: Number(row["pk"]) > 0,
  }));
  if (columns.length === 0) {
    return null;
  }
  const uniqueColumns = new Set(columns.filter((column) => column.primaryKey).map((column) => column.name));
  if (uniqueColumns.size > 1) {
    // A composite primary key makes none of its columns unique on its own.
    uniqueColumns.clear();
  }
  const indexedColumns = new Set<string>();
  for (const index of rows(connection, "index_list", table)) {
    const indexColumns = rows(connection, "index_info", String(index["name"])).sort((a, b) => Number(a["seqno"]) - Number(b["seqno"]));
    const first = indexColumns[0]?.["name"];
    if (typeof first === "string") {
      indexedColumns.add(first);
      if (index["unique"] === 1 && indexColumns.length === 1) {
        uniqueColumns.add(first);
      }
    }
  }
  const foreignKeys = rows(connection, "foreign_key_list", table).map((row) => ({
    from: String(row["from"]),
    table: String(row["table"]),
    to: String(row["to"]),
  }));
  return { columns, uniqueColumns: [...uniqueColumns], indexedColumns: [...indexedColumns], foreignKeys };
}
