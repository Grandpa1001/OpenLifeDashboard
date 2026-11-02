// The screens of the owner in the system preview (D32.1): `screen`, `widget` and `binding`, the tables
// this module owns, with the columns of the preview only (no owner, no stored state of a widget).
import { SYSTEM_TABLES, type SystemTableSource } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { systemTableSource } from "../system-table-source.js";

const selectOf = (alias: string, columns: readonly string[]): string => columns.map((column) => `${alias}.${column}`).join(", ");

export function bindDashboardSystemTables(tx: TransactionHandle): Readonly<{ screen: SystemTableSource; widget: SystemTableSource; binding: SystemTableSource }> {
  return {
    screen: systemTableSource(tx, {
      count: "SELECT count(*) AS n FROM screen s WHERE s.user_id = ?",
      select: `SELECT ${selectOf("s", SYSTEM_TABLES.screen)} FROM screen s WHERE s.user_id = ? ORDER BY s.created_at, s.id`,
      columns: SYSTEM_TABLES.screen,
      ownerParams: 1,
    }),
    widget: systemTableSource(tx, {
      count: "SELECT count(*) AS n FROM widget w JOIN screen s ON s.id = w.screen_id WHERE s.user_id = ?",
      select: `SELECT ${selectOf("w", SYSTEM_TABLES.widget)} FROM widget w JOIN screen s ON s.id = w.screen_id WHERE s.user_id = ? ORDER BY s.created_at, s.id, w.position, w.id`,
      columns: SYSTEM_TABLES.widget,
      ownerParams: 1,
    }),
    binding: systemTableSource(tx, {
      count: "SELECT count(*) AS n FROM binding b JOIN widget w ON w.id = b.widget_id JOIN screen s ON s.id = w.screen_id WHERE s.user_id = ?",
      select: `SELECT ${selectOf("b", SYSTEM_TABLES.binding)} FROM binding b JOIN widget w ON w.id = b.widget_id JOIN screen s ON s.id = w.screen_id WHERE s.user_id = ? ORDER BY s.created_at, s.id, w.position, w.id, b.position, b.slot, b.ordinal`,
      columns: SYSTEM_TABLES.binding,
      ownerParams: 1,
    }),
  };
}
