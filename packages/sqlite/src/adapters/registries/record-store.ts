// RecordStore on the handle of a unit of work (Architektura §4.3, §4.6, §5.4; D15.2, D23.1): the
// rows of `reg_<symbol>`. Every identifier of a statement is taken from the registry of the catalog and
// passes `quoteIdentifier`; a request supplies only values, bound as parameters. A write (an add, a
// change or a delete) raises the `data_revision` of the registry in the same unit (§18.2); a change
// and a delete match the stored revision in their own statement (compare and set); and a list is a page and its count read
// from one handle, so inside a read unit they come from one snapshot; a search filters both alike.
// The preview of a structure change (D26.2) counts the records and the values of a column and reads
// one column of every record row by row, never the whole table at once.
import { isSearchable, PAGE_SIZE_MAX, PAGE_SIZE_MIN, SEARCH_MAX_CODE_POINTS, tableNameOf, type CellValue, type RecordPage, type RecordPageQuery, type RecordStore, type StoredColumn, type StoredRecord, type StoredRegistry } from "@openlife/core/registries";
import { foldText, TEXT_FOLD_FUNCTION } from "../../connection/open-database.js";
import type { TransactionHandle, TransactionStatement } from "../../transactions/unit-of-work.js";
import { quoteIdentifier, UnsafeIdentifierError } from "./registry-ddl.js";

type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string; revision: number };

const SYSTEM_SORTS: ReadonlySet<string> = new Set(["created_at", "updated_at", "id"]);

/** The table of a registry, only when the catalog's own name is the one its symbol gives. */
function tableOf(registry: StoredRegistry): string {
  if (registry.tableName !== tableNameOf(registry.symbol)) throw new UnsafeIdentifierError("a table name");
  return quoteIdentifier(registry.tableName);
}

/** `%`, `_` and the escape itself are the owner's text, not wildcards (Architektura §4.5 p. 10). */
const likeLiteral = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/** The filter of a search and its parameters: a fragment of any textual column, both sides folded. */
function searchFilter(registry: StoredRegistry, search: string | null): { sql: string; params: unknown[] } {
  if (search === null) return { sql: "", params: [] };
  if (search.trim() !== search || search.length === 0 || [...search].length > SEARCH_MAX_CODE_POINTS) throw new RangeError("the search is not one resolveSearch gives");
  const columns = registry.columns.filter((column) => isSearchable(column.type));
  if (columns.length === 0) return { sql: " AND 0", params: [] };
  const pattern = `%${likeLiteral(foldText(search))}%`;
  return {
    sql: ` AND (${columns.map((column) => `${TEXT_FOLD_FUNCTION}(${quoteIdentifier(column.symbol)}) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    params: columns.map(() => pattern),
  };
}

const encode = (column: StoredColumn, value: CellValue | undefined): unknown => {
  if (value === undefined || value === null) return null;
  return column.type === "boolean" ? (value === true ? 1 : 0) : value;
};

const decode = (column: StoredColumn, value: unknown): CellValue => {
  if (value === null || value === undefined) return null;
  return column.type === "boolean" ? value === 1 : (value as CellValue);
};

/** A column of the catalog by its symbol: a name outside the registry never reaches SQL. */
function columnOf(registry: StoredRegistry, symbol: string): StoredColumn {
  const column = registry.columns.find((each) => each.symbol === symbol);
  if (column === undefined) throw new TypeError(`${symbol} is not a column of the registry`);
  return column;
}

export function bindRecordStore(tx: TransactionHandle): RecordStore {
  // Statements are built from the catalog, so there are few of them per unit; they are kept for the unit.
  const statements = new Map<string, TransactionStatement>();
  const prepared = (sql: string): TransactionStatement => {
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = tx.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  const raiseRevision = tx.prepare("UPDATE registry SET data_revision = data_revision + 1 WHERE id = ? AND user_id = ? AND schema_revision = ? AND deleted_at IS NULL");

  const selectList = (registry: StoredRegistry): string => ["id", "created_at", "updated_at", "revision", ...registry.columns.map((column) => column.symbol)].map(quoteIdentifier).join(", ");
  const recordOf = (registry: StoredRegistry, row: Row): StoredRecord => ({
    id: row.id,
    registryId: registry.id,
    ownerId: registry.ownerId,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    values: Object.fromEntries(registry.columns.map((column) => [column.symbol, decode(column, row[column.symbol])])),
  });

  return {
    insert(registry, record): void {
      const table = tableOf(registry);
      if (registry.deletedAt !== null) throw new TypeError("a record cannot be added to a deleted registry");
      if (record.registryId !== registry.id || record.ownerId !== registry.ownerId) throw new TypeError("the record does not belong to this registry");
      const known = new Set(registry.columns.map((column) => column.symbol));
      for (const symbol of Object.keys(record.values)) if (!known.has(symbol)) throw new TypeError(`${symbol} is not a column of the registry`);

      const names = ["id", "user_id", "created_at", "updated_at", "revision", ...registry.columns.map((column) => column.symbol)].map(quoteIdentifier);
      const insert = prepared(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
      insert.run(record.id, registry.ownerId, record.createdAt, record.updatedAt, record.revision, ...registry.columns.map((column) => encode(column, record.values[column.symbol])));
      // The catalog row is matched on the schema the record was checked against, so a registry that
      // changed or was deleted since it was read takes the insert back with the whole unit.
      if (raiseRevision.run(registry.id, registry.ownerId, registry.schemaRevision).changes !== 1) throw new TypeError("the registry changed or was deleted since it was read");
    },

    replaceIfRevision(registry, record, expectedRevision): boolean {
      const table = tableOf(registry);
      if (registry.deletedAt !== null) throw new TypeError("a record of a deleted registry cannot be changed");
      if (record.registryId !== registry.id || record.ownerId !== registry.ownerId) throw new TypeError("the record does not belong to this registry");
      if (record.revision !== expectedRevision + 1) throw new TypeError("a change raises the revision by one");
      const known = new Set(registry.columns.map((column) => column.symbol));
      for (const symbol of Object.keys(record.values)) if (!known.has(symbol)) throw new TypeError(`${symbol} is not a column of the registry`);

      const assignments = ["updated_at", "revision", ...registry.columns.map((column) => column.symbol)].map((name) => `${quoteIdentifier(name)} = ?`);
      const update = prepared(`UPDATE ${table} SET ${assignments.join(", ")} WHERE "id" = ? AND "user_id" = ? AND "revision" = ?`);
      const changed = update.run(record.updatedAt, record.revision, ...registry.columns.map((column) => encode(column, record.values[column.symbol])), record.id, registry.ownerId, expectedRevision).changes;
      if (changed === 0) return false;
      if (raiseRevision.run(registry.id, registry.ownerId, registry.schemaRevision).changes !== 1) throw new TypeError("the registry changed or was deleted since it was read");
      return true;
    },

    deleteIfRevision(registry, recordId, expectedRevision): boolean {
      const table = tableOf(registry);
      if (registry.deletedAt !== null) throw new TypeError("a record of a deleted registry cannot be deleted");
      const removed = prepared(`DELETE FROM ${table} WHERE "id" = ? AND "user_id" = ? AND "revision" = ?`).run(recordId, registry.ownerId, expectedRevision).changes;
      if (removed === 0) return false;
      if (raiseRevision.run(registry.id, registry.ownerId, registry.schemaRevision).changes !== 1) throw new TypeError("the registry changed or was deleted since it was read");
      return true;
    },

    find(registry, recordId): StoredRecord | null {
      const row = prepared(`SELECT ${selectList(registry)} FROM ${tableOf(registry)} WHERE id = ? AND user_id = ?`).get(recordId, registry.ownerId) as Row | undefined;
      return row === undefined ? null : recordOf(registry, row);
    },

    page(registry, query: RecordPageQuery): RecordPage {
      const table = tableOf(registry);
      const { sort, direction, page, pageSize, search } = query;
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < PAGE_SIZE_MIN || pageSize > PAGE_SIZE_MAX) throw new RangeError("the page or its size is out of range");
      if (direction !== "asc" && direction !== "desc") throw new TypeError("unknown sort direction");
      const known = sort.kind === "system" ? SYSTEM_SORTS.has(sort.symbol) : registry.columns.some((column) => column.symbol === sort.symbol);
      if (!known) throw new TypeError("the sort column is not a column of the registry");

      // Empty values come last in both directions; the identifier breaks every tie the same way.
      const column = quoteIdentifier(sort.symbol);
      const order = [...(sort.kind === "column" ? [`(${column} IS NULL) ASC`] : []), `${column} ${direction === "asc" ? "ASC" : "DESC"}`, ...(sort.symbol === "id" ? [] : [`"id" ${direction === "asc" ? "ASC" : "DESC"}`])];
      const filter = searchFilter(registry, search);
      const rows = prepared(`SELECT ${selectList(registry)} FROM ${table} WHERE user_id = ?${filter.sql} ORDER BY ${order.join(", ")} LIMIT ? OFFSET ?`).all(registry.ownerId, ...filter.params, pageSize, (page - 1) * pageSize) as Row[];
      const total = (prepared(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?${filter.sql}`).get(registry.ownerId, ...filter.params) as { n: number }).n;
      return { records: rows.map((row) => recordOf(registry, row)), total };
    },

    count(registry): number {
      return (prepared(`SELECT count(*) AS n FROM ${tableOf(registry)} WHERE user_id = ?`).get(registry.ownerId) as { n: number }).n;
    },

    columnFacts(registry, columnSymbol) {
      const column = quoteIdentifier(columnOf(registry, columnSymbol).symbol);
      const row = prepared(`SELECT count(${column}) AS filled, count(*) - count(${column}) AS empty FROM ${tableOf(registry)} WHERE user_id = ?`).get(registry.ownerId) as { filled: number; empty: number };
      return { values: row.filled, empty: row.empty };
    },

    *columnValues(registry, columnSymbol) {
      const column = columnOf(registry, columnSymbol);
      const rows = prepared(`SELECT ${quoteIdentifier(column.symbol)} AS value FROM ${tableOf(registry)} WHERE user_id = ?`).iterate(registry.ownerId);
      for (const row of rows) yield decode(column, (row as { value: unknown }).value);
    },
  };
}
