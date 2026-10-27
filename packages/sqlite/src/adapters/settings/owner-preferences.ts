// OwnerPreferencesStore on the handle of a unit of work (Architektura §4.2, §14.2; D11.4): the
// owner's time zone and language in `owner_settings`, a table of the settings module.
import type { OwnerPreferences, OwnerPreferencesStore } from "@openlife/core/settings";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindOwnerPreferencesStore(tx: TransactionHandle): OwnerPreferencesStore {
  const read = tx.prepare("SELECT timezone, locale FROM owner_settings WHERE owner_id = ?");
  const write = tx.prepare(
    `INSERT INTO owner_settings (owner_id, timezone, locale, updated_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT (owner_id) DO UPDATE SET timezone = excluded.timezone, locale = excluded.locale, updated_at_ms = excluded.updated_at_ms`,
  );
  return {
    read: (ownerId) => (read.get(ownerId) as OwnerPreferences | undefined) ?? null,
    write: (ownerId, preferences, nowMs) => void write.run(ownerId, preferences.timezone, preferences.locale, nowMs),
  };
}
