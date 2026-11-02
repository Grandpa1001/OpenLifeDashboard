// The reader of the system preview (D32.1) put together from the adapters of the modules that own its
// tables (Architektura §13.4): the catalog of registries, the screens and the audit log. Every table of
// `SYSTEM_TABLES` has its source; a table missing here would not compile.
import type { SystemTableName, SystemTableReader, SystemTableSource } from "@openlife/core/registries";
import { bindAuditSystemTables } from "@openlife/sqlite/adapters/audit";
import { bindDashboardSystemTables } from "@openlife/sqlite/adapters/dashboard";
import { bindRegistrySystemTables } from "@openlife/sqlite/adapters/registries";
import type { TransactionHandle } from "@openlife/sqlite/transactions";

export function bindSystemTableReader(tx: TransactionHandle): SystemTableReader {
  const sources: Readonly<Record<SystemTableName, SystemTableSource>> = { ...bindRegistrySystemTables(tx), ...bindDashboardSystemTables(tx), ...bindAuditSystemTables(tx) };
  return {
    count: (ownerId, table) => sources[table].count(ownerId),
    page: (ownerId, table, offset, limit) => sources[table].page(ownerId, offset, limit),
  };
}
