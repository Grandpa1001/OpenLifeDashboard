// The entries of ConfigTable on the handle of a unit of work (Architektura §4.2, §13.4; D25.1):
// `config_entry`. The same table answers `Field.Config.<symbol>` through `ConfigReader`. A value is
// written and read back as it is; nothing here logs it.
import type { ConfigReader, ConfigStore, StoredConfigEntry } from "@openlife/core/configuration";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type EntryRow = { id: string; user_id: string; symbol: string; display_name: string; value: string; description: string; revision: number; created_at: string; updated_at: string };

const stored = (row: EntryRow): StoredConfigEntry => ({
  id: row.id,
  ownerId: row.user_id,
  symbol: row.symbol,
  displayName: row.display_name,
  value: row.value,
  description: row.description,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function bindConfigStore(tx: TransactionHandle): ConfigStore {
  const count = tx.prepare("SELECT count(*) AS n FROM config_entry WHERE user_id = ?");
  const symbols = tx.prepare("SELECT symbol FROM config_entry WHERE user_id = ?");
  const insert = tx.prepare("INSERT INTO config_entry (id, user_id, symbol, display_name, value, description, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)");
  const bySymbol = tx.prepare("SELECT * FROM config_entry WHERE user_id = ? AND symbol = ?");
  const all = tx.prepare("SELECT * FROM config_entry WHERE user_id = ? ORDER BY created_at, id");
  const replace = tx.prepare("UPDATE config_entry SET display_name = ?, value = ?, description = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ? AND revision = ?");
  const remove = tx.prepare("DELETE FROM config_entry WHERE id = ? AND user_id = ? AND revision = ?");

  return {
    count: (ownerId) => (count.get(ownerId) as { n: number }).n,
    takenSymbols: (ownerId) => new Set((symbols.all(ownerId) as { symbol: string }[]).map((row) => row.symbol)),
    insert(record): void {
      insert.run(record.id, record.ownerId, record.symbol, record.content.displayName, record.content.value, record.content.description, record.nowIso, record.nowIso);
    },
    find(ownerId, symbol): StoredConfigEntry | null {
      const row = bySymbol.get(ownerId, symbol) as EntryRow | undefined;
      return row === undefined ? null : stored(row);
    },
    list: (ownerId) => (all.all(ownerId) as EntryRow[]).map(stored),
    replaceIfRevision: (entry, content, expectedRevision, nowIso) => replace.run(content.displayName, content.value, content.description, nowIso, entry.id, entry.ownerId, expectedRevision).changes === 1,
    deleteIfRevision: (entry, expectedRevision) => remove.run(entry.id, entry.ownerId, expectedRevision).changes === 1,
  };
}

export function bindConfigReader(tx: TransactionHandle): ConfigReader {
  const byId = tx.prepare("SELECT symbol, value FROM config_entry WHERE id = ? AND user_id = ?");
  return {
    entry: (ownerId, entryId) => (byId.get(entryId, ownerId) as { symbol: string; value: string } | undefined) ?? null,
  };
}
