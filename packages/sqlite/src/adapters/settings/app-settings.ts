// AppSettingStore on the handle of a unit of work (Architektura §4.2, §14.1; D41.2): the application
// options the owner has changed, in `app_setting`, a table of the settings module. The store keeps
// values as they were given; the catalog decides whether they are valid.
import type { AppSettingStore } from "@openlife/core/settings";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindAppSettingStore(tx: TransactionHandle): AppSettingStore {
  const all = tx.prepare("SELECT key, value_json FROM app_setting ORDER BY key");
  const write = tx.prepare(
    `INSERT INTO app_setting (key, value_json, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms`,
  );
  const remove = tx.prepare("DELETE FROM app_setting WHERE key = ?");
  return {
    readAll: () => Object.fromEntries((all.all() as Array<{ key: string; value_json: string }>).map((row) => [row.key, JSON.parse(row.value_json) as unknown])),
    writeMany: (values, nowMs) => {
      for (const [key, value] of Object.entries(values)) write.run(key, JSON.stringify(value), nowMs);
    },
    remove: (key) => Number(remove.run(key).changes) > 0,
  };
}
