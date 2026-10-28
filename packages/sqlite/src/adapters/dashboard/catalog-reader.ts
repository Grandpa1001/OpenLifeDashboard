// DashboardCatalogReader on the handle of a unit of work (Architektura §5.6, §18.3; D17.3): the
// registries of the owner by identifier with their columns, deleted ones included (a binding to a
// deleted column is broken, not unknown), and the screen a widget identifier lives on, whoever
// owns it.
import type { CatalogRegistry, DashboardCatalogReader } from "@openlife/core/dashboard";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindCatalogReader(tx: TransactionHandle): DashboardCatalogReader {
  const registry = tx.prepare("SELECT id, symbol, deleted_at FROM registry WHERE id = ? AND user_id = ?");
  const columns = tx.prepare("SELECT id, symbol, deleted_at FROM registry_column WHERE registry_id = ? ORDER BY position, id");
  const widgetScreen = tx.prepare("SELECT screen_id FROM widget WHERE id = ?");
  return {
    registry(ownerId, registryId): CatalogRegistry | null {
      const row = registry.get(registryId, ownerId) as { id: string; symbol: string; deleted_at: string | null } | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        symbol: row.symbol,
        deleted: row.deleted_at !== null,
        columns: (columns.all(row.id) as { id: string; symbol: string; deleted_at: string | null }[]).map((column) => ({ id: column.id, symbol: column.symbol, deleted: column.deleted_at !== null })),
      };
    },
    screenOfWidget: (widgetId) => (widgetScreen.get(widgetId) as { screen_id: string } | undefined)?.screen_id ?? null,
  };
}
