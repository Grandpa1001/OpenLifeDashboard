// DashboardCatalogReader on the handle of a unit of work (Architektura §5.6, §18.3; D17.3): the
// registries of the owner by identifier with their columns, deleted ones included (a binding to a
// deleted column is broken, not unknown), the symbol of an entry of ConfigTable (D25.1), and the
// screen a widget identifier lives on, whoever owns it. The bindings that point at entries are
// counted here too, and the widgets a change of a registry's structure would touch are listed here
// (D26.2): the SQL of `binding` stays in the adapter of the dashboard (Architektura §13.4).
import type { ConfigBindingCounts } from "@openlife/core/configuration";
import type { CatalogRegistry, DashboardCatalogReader } from "@openlife/core/dashboard";
import type { DependentWidget, DependentWidgets } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindCatalogReader(tx: TransactionHandle): DashboardCatalogReader {
  const registry = tx.prepare("SELECT id, symbol, deleted_at FROM registry WHERE id = ? AND user_id = ?");
  const columns = tx.prepare("SELECT id, symbol, deleted_at FROM registry_column WHERE registry_id = ? ORDER BY position, id");
  const widgetScreen = tx.prepare("SELECT screen_id FROM widget WHERE id = ?");
  const configEntry = tx.prepare("SELECT symbol FROM config_entry WHERE id = ? AND user_id = ?");
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
    configEntry: (ownerId, entryId) => (configEntry.get(entryId, ownerId) as { symbol: string } | undefined) ?? null,
    screenOfWidget: (widgetId) => (widgetScreen.get(widgetId) as { screen_id: string } | undefined)?.screen_id ?? null,
  };
}

export function bindConfigBindingCounts(tx: TransactionHandle): ConfigBindingCounts {
  const counts = tx.prepare(
    `SELECT json_extract(binding.target, '$.entryId') AS entry, count(*) AS n
       FROM binding JOIN widget ON widget.id = binding.widget_id JOIN screen ON screen.id = widget.screen_id
      WHERE screen.user_id = ? AND json_extract(binding.target, '$.kind') = 'config'
      GROUP BY entry`,
  );
  return {
    counts: (ownerId) => new Map((counts.all(ownerId) as { entry: string; n: number }[]).map((row) => [row.entry, row.n])),
  };
}

export function bindDependentWidgets(tx: TransactionHandle): DependentWidgets {
  // The index on the registry of a target finds the bindings; the column narrows them when one is named.
  const bound = tx.prepare(
    `SELECT screen.id AS screen_id, screen.name AS screen_name, widget.id AS widget_id, json_extract(widget.config, '$.title') AS title, binding.slot AS slot
       FROM binding JOIN widget ON widget.id = binding.widget_id JOIN screen ON screen.id = widget.screen_id
      WHERE screen.user_id = ? AND json_extract(binding.target, '$.registryId') = ?
        AND (? IS NULL OR (json_extract(binding.target, '$.kind') = 'column' AND json_extract(binding.target, '$.columnId') = ?))
      ORDER BY screen.created_at, screen.id, widget.position, widget.id, binding.position, binding.slot`,
  );
  const perRegistry = tx.prepare(
    `SELECT json_extract(binding.target, '$.registryId') AS registry_id, count(DISTINCT widget.id) AS n
       FROM binding JOIN widget ON widget.id = binding.widget_id JOIN screen ON screen.id = widget.screen_id
      WHERE screen.user_id = ? GROUP BY registry_id`,
  );
  return {
    countByRegistry(ownerId): ReadonlyMap<string, number> {
      const rows = perRegistry.all(ownerId) as { registry_id: unknown; n: number }[];
      return new Map(rows.flatMap((row) => (typeof row.registry_id === "string" ? [[row.registry_id, row.n] as const] : [])));
    },
    of(ownerId, registryId, columnId): readonly DependentWidget[] {
      const rows = bound.all(ownerId, registryId, columnId, columnId) as { screen_id: string; screen_name: string; widget_id: string; title: unknown; slot: string }[];
      const widgets = new Map<string, { screenId: string; screenName: string; widgetId: string; title: string | null; slots: string[] }>();
      for (const row of rows) {
        let widget = widgets.get(row.widget_id);
        if (widget === undefined) {
          widget = { screenId: row.screen_id, screenName: row.screen_name, widgetId: row.widget_id, title: typeof row.title === "string" && row.title !== "" ? row.title : null, slots: [] };
          widgets.set(row.widget_id, widget);
        }
        if (!widget.slots.includes(row.slot)) widget.slots.push(row.slot);
      }
      return [...widgets.values()];
    },
  };
}
