// RecordStore on the handle of a unit of work (Architektura §4.3, §4.6, §5.4; D15.2): the rows of
// `reg_<symbol>`. Every identifier of a statement is taken from the registry of the catalog and
// passes `quoteIdentifier`; a request supplies only values, bound as parameters. A write raises the
// `data_revision` of the registry in the same unit (§18.2), and a list is a page and its count read
// from one handle, so inside a read unit they come from one snapshot.
import { PAGE_SIZE_MAX, PAGE_SIZE_MIN, tableNameOf, type CellValue, type RecordPage, type RecordPageQuery, type RecordStore, type StoredColumn, type StoredRecord, type StoredRegistry } from "@openlife/core/registries";
import type { TransactionHandle, TransactionStatement } from "../../transactions/unit-of-work.js";
import { quoteIdentifier, UnsafeIdentifierError } from "./registry-ddl.js";

type Row = Record<string, unknown> & { id: string; created_at: string; updated_at: string; revision: number };

const SYSTEM_SORTS: ReadonlySet<string> = new Set(["created_at", "updated_at", "id"]);

/** The table of a registry, only when the catalog's own name is the one its symbol gives. */
function tableOf(registry: StoredRegistry): string {
  if (registry.tableName !== tableNameOf(registry.symbol)) throw new UnsafeIdentifierError("a table name");
  return quoteIdentifier(registry.tableName);
}

const encode = (column: StoredColumn, value: CellValue | undefined): unknown => {
  if (value === undefined || value === null) return null;
  return column.type === "boolean" ? (value === true ? 1 : 0) : value;
};

const decode = (column: StoredColumn, value: unknown): CellValue => {
  if (value === null || value === undefined) return null;
  return column.type === "boolean" ? value === 1 : (value as CellValue);
};

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

    find(registry, recordId): StoredRecord | null {
      const row = prepared(`SELECT ${selectList(registry)} FROM ${tableOf(registry)} WHERE id = ? AND user_id = ?`).get(recordId, registry.ownerId) as Row | undefined;
      return row === undefined ? null : recordOf(registry, row);
    },

    page(registry, query: RecordPageQuery): RecordPage {
      const table = tableOf(registry);
      const { sort, direction, page, pageSize } = query;
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < PAGE_SIZE_MIN || pageSize > PAGE_SIZE_MAX) throw new RangeError("the page or its size is out of range");
      if (direction !== "asc" && direction !== "desc") throw new TypeError("unknown sort direction");
      const known = sort.kind === "system" ? SYSTEM_SORTS.has(sort.symbol) : registry.columns.some((column) => column.symbol === sort.symbol);
      if (!known) throw new TypeError("the sort column is not a column of the registry");

      // Empty values come last in both directions; the identifier breaks every tie the same way.
      const column = quoteIdentifier(sort.symbol);
      const order = [...(sort.kind === "column" ? [`(${column} IS NULL) ASC`] : []), `${column} ${direction === "asc" ? "ASC" : "DESC"}`, ...(sort.symbol === "id" ? [] : [`"id" ${direction === "asc" ? "ASC" : "DESC"}`])];
      const rows = prepared(`SELECT ${selectList(registry)} FROM ${table} WHERE user_id = ? ORDER BY ${order.join(", ")} LIMIT ? OFFSET ?`).all(registry.ownerId, pageSize, (page - 1) * pageSize) as Row[];
      const total = (prepared(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).get(registry.ownerId) as { n: number }).n;
      return { records: rows.map((row) => recordOf(registry, row)), total };
    },
  };
}
