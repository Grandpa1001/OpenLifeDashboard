// RegistryTables on the handle of a unit of work (Architektura §5.2; D30.1, D30.2): the table of a
// registry dropped as a whole when the registry is deleted, and made again from its definition when it
// is restored from its copy. The name comes from the catalog and passes the same identifier rules as
// the table itself; SQLite drops the indexes with the table, and a restore creates them as a new
// registry would. Rows go back as they were stored, with their identifiers, owner, times and
// revisions, page by page; values are always parameters. Any failure throws and the unit takes
// everything back.
import { tableNameOf, type RegistryTables, type StoredRegistry } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { quoteIdentifier, registryDdl, UnsafeIdentifierError } from "./registry-ddl.js";

const ENGINE_COLUMNS = ["id", "user_id", "created_at", "updated_at", "revision"] as const;

function checkedName(registry: StoredRegistry): string {
  if (registry.tableName !== tableNameOf(registry.symbol)) throw new UnsafeIdentifierError("a table name");
  return quoteIdentifier(registry.tableName);
}

export function bindRegistryTables(tx: TransactionHandle): RegistryTables {
  return {
    drop(registry) {
      if (registry.deletedAt !== null) throw new TypeError("the table of a deleted registry is gone already");
      tx.prepare(`DROP TABLE ${checkedName(registry)}`).run();
    },

    restore(registry, pages) {
      const table = checkedName(registry);
      const ddl = registryDdl({ symbol: registry.symbol, displayName: registry.displayName, columns: registry.columns });
      tx.prepare(ddl.table).run();
      for (const index of ddl.indexes) tx.prepare(index).run();
      const names = [...ENGINE_COLUMNS, ...registry.columns.map((column) => column.symbol)];
      const insert = tx.prepare(`INSERT INTO ${table} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`);
      let rows = 0;
      for (const page of pages) {
        for (const row of page) {
          if (row["user_id"] !== registry.ownerId) throw new TypeError("a row of the copy belongs to another owner");
          insert.run(...names.map((name) => row[name] ?? null));
          rows += 1;
        }
      }
      return rows;
    },
  };
}
