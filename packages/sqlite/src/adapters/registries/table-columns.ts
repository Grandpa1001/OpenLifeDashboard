// TableColumns on the handle of a unit of work (Architektura §4.5 p. 3, 6, §5.2; D28.1): the DDL of
// one column of `reg_<symbol>`, built from the catalog and passing the same identifier rules as the
// table itself. An added column has the type and the check a new registry would give it, and its
// index for a date; a removed column loses its index first, since SQLite will not drop an indexed
// column. Values are always parameters. Any failure throws and the unit takes everything back.
import { tableNameOf, type StoredColumn, type StoredRegistry, type TableColumns } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { decodeCell, encodeCell } from "./cell-encoding.js";
import { columnSql, indexNameOf, indexSql, isIndexed, quoteIdentifier, UnsafeIdentifierError } from "./registry-ddl.js";
import { REBUILD_PAGE_ROWS } from "./table-rebuild.js";

function tableOf(registry: StoredRegistry): string {
  if (registry.deletedAt !== null) throw new TypeError("a column of a deleted registry is not changed");
  if (registry.tableName !== tableNameOf(registry.symbol)) throw new UnsafeIdentifierError("a table name");
  return quoteIdentifier(registry.tableName);
}

export function bindTableColumns(tx: TransactionHandle): TableColumns {
  return {
    add(registry, column: StoredColumn, fill) {
      const table = tableOf(registry);
      if (registry.columns.some((each) => each.symbol === column.symbol)) throw new TypeError(`${column.symbol} is a column of the registry already`);
      tx.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnSql(column)}`).run();
      if (isIndexed(column)) tx.prepare(indexSql(registry.tableName, column)).run();
      if (fill === null) return 0;
      return tx.prepare(`UPDATE ${table} SET ${quoteIdentifier(column.symbol)} = ? WHERE "user_id" = ?`).run(encodeCell(column, fill), registry.ownerId).changes;
    },

    remove(registry, column) {
      const table = tableOf(registry);
      if (!registry.columns.some((each) => each.id === column.id && each.symbol === column.symbol)) throw new TypeError(`${column.symbol} is not a column of the registry`);
      tx.prepare(`DROP INDEX IF EXISTS ${quoteIdentifier(indexNameOf(registry.tableName, column))}`).run();
      tx.prepare(`ALTER TABLE ${table} DROP COLUMN ${quoteIdentifier(column.symbol)}`).run();
    },

    fillEmpty(registry, column, value, isEmpty) {
      const table = tableOf(registry);
      if (!registry.columns.some((each) => each.id === column.id && each.symbol === column.symbol)) throw new TypeError(`${column.symbol} is not a column of the registry`);
      const name = quoteIdentifier(column.symbol);
      // Page by page by the identifier: a page is read whole before its cells are written.
      const page = tx.prepare(`SELECT "id", ${name} AS value FROM ${table} WHERE "user_id" = ? AND "id" > ? ORDER BY "id" LIMIT ?`);
      const write = tx.prepare(`UPDATE ${table} SET ${name} = ? WHERE "id" = ? AND "user_id" = ?`);
      let filled = 0;
      let after = "";
      for (;;) {
        const rows = page.all(registry.ownerId, after, REBUILD_PAGE_ROWS) as { id: string; value: unknown }[];
        for (const row of rows) {
          if (!isEmpty(decodeCell(column, row.value))) continue;
          filled += write.run(encodeCell(column, value), row.id, registry.ownerId).changes;
        }
        if (rows.length < REBUILD_PAGE_ROWS) break;
        after = rows[rows.length - 1]!.id;
      }
      return filled;
    },
  };
}
