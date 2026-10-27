// DDL of a registry's table, built only from the validated definition (Architektura §5.1): the
// identifiers pass the symbol rule of core/registries again and are quoted, the types come from a
// fixed table, and no text of the user is ever a part of a statement.
import { checkSymbol, tableNameOf, type ColumnType, type NewColumn, type NewRegistry } from "@openlife/core/registries";

/** The SQLite type of each column type (Architektura §4.3). */
const SQLITE_TYPE: Readonly<Record<ColumnType, "TEXT" | "REAL" | "INTEGER">> = {
  text: "TEXT",
  number: "REAL",
  money: "INTEGER",
  date: "TEXT",
  datetime: "TEXT",
  time: "TEXT",
  boolean: "INTEGER",
  choice: "TEXT",
};

/** The columns every table of a registry has before the owner's own. */
const ENGINE_COLUMNS = [
  `"id" TEXT NOT NULL PRIMARY KEY`,
  `"user_id" TEXT NOT NULL REFERENCES "user" ("id")`,
  `"created_at" TEXT NOT NULL`,
  `"updated_at" TEXT NOT NULL`,
  `"revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1)`,
] as const;

/** Raised when a name that is about to become an identifier does not pass the rule: a bug upstream, never a state of the data. */
export class UnsafeIdentifierError extends Error {
  constructor(what: string) {
    super(`${what} is not a safe identifier`);
    this.name = "UnsafeIdentifierError";
  }
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/** A name in double quotes; it can hold no quote, so nothing can end the identifier early. */
export function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name) || name.length > 100) throw new UnsafeIdentifierError("a name");
  return `"${name}"`;
}

function columnSql(column: NewColumn): string {
  if (checkSymbol(column.symbol, "column", new Set()) !== null) throw new UnsafeIdentifierError("a column symbol");
  const guard = column.type === "boolean" ? ` CHECK (${quoteIdentifier(column.symbol)} IN (0, 1))` : "";
  return `${quoteIdentifier(column.symbol)} ${SQLITE_TYPE[column.type]}${guard}`;
}

/** Date and date-time columns are indexed: widgets ask for ranges of them (Architektura §4.3). */
const isIndexed = (column: NewColumn): boolean => column.type === "date" || column.type === "datetime";

export type RegistryDdl = Readonly<{ table: string; indexes: readonly string[] }>;

export function registryDdl(definition: NewRegistry): RegistryDdl {
  if (checkSymbol(definition.symbol, "registry", new Set()) !== null) throw new UnsafeIdentifierError("a registry symbol");
  const tableName = tableNameOf(definition.symbol);
  const table = quoteIdentifier(tableName);
  const body = [...ENGINE_COLUMNS, ...definition.columns.map(columnSql)].join(",\n  ");
  return {
    table: `CREATE TABLE ${table} (\n  ${body}\n) STRICT`,
    indexes: definition.columns.filter(isIndexed).map((column) => `CREATE INDEX ${quoteIdentifier(`idx_${tableName}_${column.symbol}`)} ON ${table} (${quoteIdentifier(column.symbol)})`),
  };
}
