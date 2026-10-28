// DashboardStore on the handle of a unit of work (Architektura §4.2, §18.5; D17.3): the screen, its
// widgets and their bindings in `screen`, `widget` and `binding`. A replacement is a sequence of
// statements of one transaction, so a failure anywhere leaves the screen as it was; the guards here
// do not trust the rules before them: a screen is always matched on its owner, and a widget
// identifier that lives on another screen is never overwritten.
import type { CheckedDesign, DashboardStore, FieldRef, Layout, SlotBinding, StoredScreen, StoredWidget, WidgetState } from "@openlife/core/dashboard";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type ScreenRow = { id: string; user_id: string; name: string; theme: string; accent: string; created_at: string; updated_at: string };
type WidgetRow = { id: string; screen_id: string; type: string; config: string; layout: string; state: WidgetState };
type BindingRow = { widget_id: string; slot: string; ordinal: number; path: string; target: string };

export function bindDashboardStore(tx: TransactionHandle): DashboardStore {
  const count = tx.prepare("SELECT count(*) AS n FROM screen WHERE user_id = ?");
  const listScreens = tx.prepare("SELECT id, name, created_at FROM screen WHERE user_id = ? ORDER BY created_at, id");
  const insertScreen = tx.prepare("INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const screenOf = tx.prepare("SELECT * FROM screen WHERE id = ? AND user_id = ?");
  const widgetsOf = tx.prepare("SELECT id, screen_id, type, config, layout, state FROM widget WHERE screen_id = ? ORDER BY position, id");
  const widgetById = tx.prepare("SELECT w.id, w.screen_id, w.type, w.config, w.layout, w.state FROM widget w JOIN screen s ON s.id = w.screen_id WHERE w.id = ? AND s.user_id = ?");
  const bindingsOf = tx.prepare("SELECT widget_id, slot, ordinal, path, target FROM binding WHERE widget_id = ? ORDER BY position");
  const updateScreen = tx.prepare("UPDATE screen SET name = ?, theme = ?, accent = ?, updated_at = ? WHERE id = ? AND user_id = ?");
  const idsOnScreen = tx.prepare("SELECT id FROM widget WHERE screen_id = ?");
  const deleteWidget = tx.prepare("DELETE FROM widget WHERE id = ? AND screen_id = ?");
  // A widget identifier that is on another screen matches no row of the conflict clause: nothing is changed and the write fails below.
  const upsertWidget = tx.prepare(
    `INSERT INTO widget (id, screen_id, position, type, config, layout, state) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET position = excluded.position, type = excluded.type, config = excluded.config, layout = excluded.layout, state = excluded.state
     WHERE widget.screen_id = excluded.screen_id`,
  );
  const clearBindings = tx.prepare("DELETE FROM binding WHERE widget_id = ?");
  const insertBinding = tx.prepare("INSERT INTO binding (widget_id, slot, ordinal, position, path, target) VALUES (?, ?, ?, ?, ?, ?)");

  const widgetOf = (row: WidgetRow): StoredWidget => ({
    id: row.id,
    type: row.type,
    config: JSON.parse(row.config) as Record<string, unknown>,
    layout: JSON.parse(row.layout) as Layout,
    bindings: (bindingsOf.all(row.id) as BindingRow[]).map((binding): SlotBinding => ({ slot: binding.slot, ordinal: binding.ordinal, path: binding.path, target: JSON.parse(binding.target) as FieldRef })),
    state: row.state,
  });

  return {
    count: (ownerId) => (count.get(ownerId) as { n: number }).n,

    list: (ownerId) => (listScreens.all(ownerId) as { id: string; name: string; created_at: string }[]).map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at })),

    create(screen): void {
      insertScreen.run(screen.id, screen.ownerId, screen.name, screen.theme, screen.accent, screen.nowIso, screen.nowIso);
    },

    find(ownerId, screenId): StoredScreen | null {
      const row = screenOf.get(screenId, ownerId) as ScreenRow | undefined;
      if (row === undefined) return null;
      return {
        id: row.id,
        ownerId: row.user_id,
        name: row.name,
        theme: row.theme,
        accent: row.accent,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        widgets: (widgetsOf.all(row.id) as WidgetRow[]).map(widgetOf),
      };
    },

    findWidget(ownerId, widgetId) {
      const row = widgetById.get(widgetId, ownerId) as WidgetRow | undefined;
      return row === undefined ? null : { screenId: row.screen_id, widget: widgetOf(row) };
    },

    replace(ownerId, screenId, design: CheckedDesign, nowIso): void {
      if (updateScreen.run(design.name, design.theme, design.accent, nowIso, screenId, ownerId).changes !== 1) {
        throw new TypeError("the screen is not the owner's");
      }
      const kept = new Set(design.widgets.map((widget) => widget.id));
      for (const { id } of idsOnScreen.all(screenId) as { id: string }[]) {
        if (!kept.has(id)) deleteWidget.run(id, screenId);
      }
      design.widgets.forEach((widget, position) => {
        const written = upsertWidget.run(widget.id, screenId, position, widget.type, JSON.stringify(widget.config), JSON.stringify(widget.layout), widget.state);
        if (written.changes !== 1) throw new TypeError("the widget identifier belongs to another screen");
        clearBindings.run(widget.id);
        widget.bindings.forEach((binding, index) => insertBinding.run(widget.id, binding.slot, binding.ordinal, index, binding.path, JSON.stringify(binding.target)));
      });
    },
  };
}
