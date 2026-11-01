// TableRebuild on the handle of a unit of work (Architektura §4.5 p. 3, 5–7, §5.2; D27.1): the
// rebuild of `reg_<symbol>` for a change of one column, in the writer's transaction, in the order the
// work order names its stages:
//   1. `CREATE TABLE reg_<symbol>__rebuild` from the target definition, by the DDL a new registry gets
//      (no symbol holds `__`, so the name cannot be a registry's);
//   2. every row copied in pages by its identifier, with its owner, times and revision, the one column
//      rewritten by the plan and bound as a parameter (never a cast of SQLite);
//   3. the number of rows of both tables compared and the foreign keys of the new one checked;
//   4. the old table dropped (its indexes with it);
//   5. the new table renamed to the registry's;
//   6. the indexes made again under the names a new registry gives them.
// Any failure throws; the unit takes back every stage, the catalog and the audit with them.
import { tableNameOf, type RebuiltColumn, type StoredColumn, type StoredRegistry, type TableRebuild } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { decodeCell, encodeCell } from "./cell-encoding.js";
import { quoteIdentifier, registryDdl, registryTableSql, UnsafeIdentifierError } from "./registry-ddl.js";

/** Rows copied per page: a page is read whole before it is written, so a large table is never held in memory. */
export const REBUILD_PAGE_ROWS = 1000;
const ENGINE_FIELDS = ["id", "user_id", "created_at", "updated_at", "revision"] as const;
export const REBUILD_TABLE_SUFFIX = "__rebuild";

type Row = Record<string, unknown> & { id: string };

export function bindTableRebuild(tx: TransactionHandle): TableRebuild {
  return {
    rebuild(registry: StoredRegistry, columns: readonly StoredColumn[], changed: RebuiltColumn) {
      if (registry.deletedAt !== null) throw new TypeError("a deleted registry is not rebuilt");
      if (registry.tableName !== tableNameOf(registry.symbol)) throw new UnsafeIdentifierError("a table name");
      const old = registry.columns.find((column) => column.symbol === changed.symbol);
      const target = columns.find((column) => column.symbol === changed.symbol);
      if (old === undefined || target === undefined) throw new TypeError(`${changed.symbol} is not a column of the registry`);
      // The rebuild changes one column's values and definition; every other column is copied as it is.
      if (columns.length !== registry.columns.length || columns.some((column, index) => column.id !== registry.columns[index]?.id || column.symbol !== registry.columns[index]?.symbol)) {
        throw new TypeError("a rebuild keeps the columns of the registry, in their order");
      }
      const definition = { symbol: registry.symbol, displayName: registry.displayName, columns };
      const ddl = registryDdl(definition);
      const table = quoteIdentifier(registry.tableName);
      const staging = quoteIdentifier(`${registry.tableName}${REBUILD_TABLE_SUFFIX}`);
      const names = [...ENGINE_FIELDS, ...columns.map((column) => column.symbol)];
      const list = names.map(quoteIdentifier).join(", ");

      // 1. The new table.
      tx.prepare(registryTableSql(definition, `${registry.tableName}${REBUILD_TABLE_SUFFIX}`)).run();

      // 2. The rows, page after page in the order of their identifiers.
      const page = tx.prepare(`SELECT ${list} FROM ${table} WHERE "user_id" = ? AND "id" > ? ORDER BY "id" LIMIT ?`);
      const insert = tx.prepare(`INSERT INTO ${staging} (${list}) VALUES (${names.map(() => "?").join(", ")})`);
      let rows = 0;
      let failed = 0;
      let after = "";
      for (;;) {
        const batch = page.all(registry.ownerId, after, REBUILD_PAGE_ROWS) as Row[];
        for (const row of batch) {
          const rewritten = changed.rewrite(decodeCell(old, row[changed.symbol]));
          if (rewritten.failed) failed += 1;
          insert.run(...ENGINE_FIELDS.map((field) => row[field]), ...columns.map((column) => (column.symbol === changed.symbol ? encodeCell(target, rewritten.value) : row[column.symbol])));
          rows += 1;
        }
        if (batch.length < REBUILD_PAGE_ROWS) break;
        after = batch[batch.length - 1]!.id;
      }

      // 3. The same rows, and no foreign key the new table breaks.
      const counted = (name: string): number => (tx.prepare(`SELECT count(*) AS n FROM ${name}`).get() as { n: number }).n;
      if (counted(staging) !== rows || counted(table) !== rows) throw new TypeError("the rebuilt table does not hold every row");
      if (tx.prepare(`PRAGMA foreign_key_check(${staging})`).all().length > 0) throw new TypeError("the rebuilt table breaks a foreign key");

      // 4–6. The old table replaced by the new one under its name, and the indexes made again.
      tx.prepare(`DROP TABLE ${table}`).run();
      tx.prepare(`ALTER TABLE ${staging} RENAME TO ${table}`).run();
      for (const index of ddl.indexes) tx.prepare(index).run();
      return { rows, failed };
    },
  };
}
