// The dictionaries of the owner on the handle of a unit of work (Architektura §4.2, §13.4; D24.1):
// `dictionary` and `dictionary_value`. The same tables answer the registries through their port
// `DictionaryLookup` (which dictionaries a column may name, the labels of a page), so the labels of
// a page are read in the snapshot of the page. No statement here touches a record.
import type { DictionaryStore, StoredDictionary, StoredDictionaryValue } from "@openlife/core/dictionaries";
import type { DictionaryLookup } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type DictionaryRow = { id: string; user_id: string; symbol: string; display_name: string; revision: number; created_at: string; updated_at: string };
type ValueRow = { id: string; symbol: string; label: string; position: number; hidden: number };

/** Parameters SQLite binds in one statement, well under its limit, for the labels of a page. */
const LABEL_BATCH = 200;

export function bindDictionaryStore(tx: TransactionHandle): DictionaryStore {
  const count = tx.prepare("SELECT count(*) AS n FROM dictionary WHERE user_id = ?");
  const symbols = tx.prepare("SELECT symbol FROM dictionary WHERE user_id = ?");
  const insertDictionary = tx.prepare("INSERT INTO dictionary (id, user_id, symbol, display_name, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)");
  const insertValue = tx.prepare("INSERT INTO dictionary_value (id, dictionary_id, symbol, label, position, hidden) VALUES (?, ?, ?, ?, ?, ?)");
  const bySymbol = tx.prepare("SELECT * FROM dictionary WHERE user_id = ? AND symbol = ?");
  const all = tx.prepare("SELECT * FROM dictionary WHERE user_id = ? ORDER BY created_at, id");
  const valuesOf = tx.prepare("SELECT id, symbol, label, position, hidden FROM dictionary_value WHERE dictionary_id = ? ORDER BY position, symbol");
  const raise = tx.prepare("UPDATE dictionary SET display_name = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ? AND revision = ?");
  const clearValues = tx.prepare("DELETE FROM dictionary_value WHERE dictionary_id = ?");
  const remove = tx.prepare("DELETE FROM dictionary WHERE id = ? AND user_id = ? AND revision = ?");

  const stored = (row: DictionaryRow): StoredDictionary => ({
    id: row.id,
    ownerId: row.user_id,
    symbol: row.symbol,
    displayName: row.display_name,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    values: (valuesOf.all(row.id) as ValueRow[]).map((value): StoredDictionaryValue => ({ id: value.id, symbol: value.symbol, label: value.label, position: value.position, hidden: value.hidden === 1 })),
  });

  return {
    count: (ownerId) => (count.get(ownerId) as { n: number }).n,
    takenSymbols: (ownerId) => new Set((symbols.all(ownerId) as { symbol: string }[]).map((row) => row.symbol)),

    insert(record): void {
      if (record.valueIds.length !== record.content.values.length) throw new TypeError("one identifier per value");
      insertDictionary.run(record.id, record.ownerId, record.symbol, record.content.displayName, record.nowIso, record.nowIso);
      record.content.values.forEach((value, position) => insertValue.run(record.valueIds[position], record.id, value.symbol, value.label, position, value.hidden ? 1 : 0));
    },

    find(ownerId, symbol): StoredDictionary | null {
      const row = bySymbol.get(ownerId, symbol) as DictionaryRow | undefined;
      return row === undefined ? null : stored(row);
    },

    list: (ownerId) => (all.all(ownerId) as DictionaryRow[]).map(stored),

    replaceIfRevision(dictionary, content, expectedRevision, newId, nowIso): boolean {
      if (raise.run(content.displayName, nowIso, dictionary.id, dictionary.ownerId, expectedRevision).changes !== 1) return false;
      // A value keeps its identifier by its symbol; the list is written again in its new order.
      const ids = new Map(dictionary.values.map((value) => [value.symbol, value.id]));
      clearValues.run(dictionary.id);
      content.values.forEach((value, position) => insertValue.run(ids.get(value.symbol) ?? newId(), dictionary.id, value.symbol, value.label, position, value.hidden ? 1 : 0));
      return true;
    },

    deleteIfRevision(dictionary, expectedRevision): boolean {
      return remove.run(dictionary.id, dictionary.ownerId, expectedRevision).changes === 1;
    },
  };
}

export function bindDictionaryLookup(tx: TransactionHandle): DictionaryLookup {
  const ids = tx.prepare("SELECT id FROM dictionary WHERE user_id = ?");
  const owned = tx.prepare("SELECT 1 FROM dictionary WHERE id = ? AND user_id = ?");
  const batches = new Map<number, ReturnType<TransactionHandle["prepare"]>>();
  const labelsOf = (size: number) => {
    let statement = batches.get(size);
    if (statement === undefined) {
      statement = tx.prepare(`SELECT symbol, label FROM dictionary_value WHERE dictionary_id = ? AND symbol IN (${Array.from({ length: size }, () => "?").join(", ")})`);
      batches.set(size, statement);
    }
    return statement;
  };
  return {
    ids: (ownerId) => new Set((ids.all(ownerId) as { id: string }[]).map((row) => row.id)),
    labels(ownerId, dictionaryId, symbols): ReadonlyMap<string, string> {
      const found = new Map<string, string>();
      // A dictionary of another owner gives no label, whatever its identifier.
      if (owned.get(dictionaryId, ownerId) === undefined) return found;
      const wanted = [...new Set(symbols)];
      for (let start = 0; start < wanted.length; start += LABEL_BATCH) {
        const batch = wanted.slice(start, start + LABEL_BATCH);
        for (const row of labelsOf(batch.length).all(dictionaryId, ...batch) as { symbol: string; label: string }[]) found.set(row.symbol, row.label);
      }
      return found;
    },
  };
}
