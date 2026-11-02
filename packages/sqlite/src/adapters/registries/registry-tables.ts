// RegistryTables on the handle of a unit of work (Architektura §5.2; D30.1): the table of a registry
// dropped as a whole when the registry is deleted. The name comes from the catalog and passes the same
// identifier rules as the table itself; SQLite drops its indexes with it. Any failure throws and the
// unit takes everything back.
import { tableNameOf, type RegistryTables } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { quoteIdentifier, UnsafeIdentifierError } from "./registry-ddl.js";

export function bindRegistryTables(tx: TransactionHandle): RegistryTables {
  return {
    drop(registry) {
      if (registry.deletedAt !== null) throw new TypeError("the table of a deleted registry is gone already");
      if (registry.tableName !== tableNameOf(registry.symbol)) throw new UnsafeIdentifierError("a table name");
      tx.prepare(`DROP TABLE ${quoteIdentifier(registry.tableName)}`).run();
    },
  };
}
