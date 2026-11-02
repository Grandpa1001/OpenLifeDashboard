// One registry read from a verified database snapshot (Architektura §11.3.3; D30.2), in isolation: a
// separate read-only connection to the copy's file, never the writer's. The catalog is read with the
// same mapping as the live store, and the rows of its table in pages by their identifier, so a large
// registry is never held in memory whole. The caller verifies the package before and closes the copy
// after its unit.
import Database from "better-sqlite3";
import { tableNameOf, type StoredRegistry, type StoredRow } from "@openlife/core/registries";
import { quoteIdentifier, UnsafeIdentifierError } from "./registry-ddl.js";
import { bindRegistryStore } from "./registry-store.js";
import { REBUILD_PAGE_ROWS } from "./table-rebuild.js";

export type RegistryCopyReader = Readonly<{
  /** The registry of this symbol as the copy holds it; null when the copy has none. */
  registry: StoredRegistry | null;
  /** Its rows in pages by identifier, as stored. */
  pages: () => Iterable<readonly StoredRow[]>;
  close: () => void;
}>;

export function openRegistryCopy(file: string, symbol: string): RegistryCopyReader {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const owners = db.prepare("SELECT DISTINCT user_id FROM registry WHERE symbol = ?").pluck().all(symbol) as string[];
    const [ownerId] = owners;
    const registry = owners.length === 1 && ownerId !== undefined ? bindRegistryStore({ prepare: (sql) => db.prepare<unknown[]>(sql) }).find(ownerId, symbol) : null;
    return {
      registry,
      *pages() {
        if (registry === null) return;
        if (registry.tableName !== tableNameOf(registry.symbol)) throw new UnsafeIdentifierError("a table name");
        const page = db.prepare(`SELECT * FROM ${quoteIdentifier(registry.tableName)} WHERE "id" > ? ORDER BY "id" LIMIT ?`);
        let after = "";
        for (;;) {
          const rows = page.all(after, REBUILD_PAGE_ROWS) as StoredRow[];
          if (rows.length === 0) return;
          yield rows;
          after = String(rows[rows.length - 1]!["id"]);
          if (rows.length < REBUILD_PAGE_ROWS) return;
        }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
