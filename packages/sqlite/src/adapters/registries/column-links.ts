// The columns that show their values through a dictionary, on the handle of a unit of work
// (Architektura §5.2, §13.4; D24.1): the catalog's side of `ColumnDictionaryLinks`. A column names
// its dictionary in `type_options.dictionaryId`, without a foreign key. Unpinning removes that key
// and nothing else: the column stays "choice", the table `reg_<symbol>` is not touched, and the
// schema revision of each registry it touches rises, so a form built before reloads its definition.
import type { ColumnDictionaryLinks, DictionaryUsage } from "@openlife/core/dictionaries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type UsageRow = { dictionary_id: string; registry_id: string; registry_symbol: string; registry_name: string; column_symbol: string; column_name: string };

const USAGES = `SELECT json_extract(c.type_options, '$.dictionaryId') AS dictionary_id, r.id AS registry_id, r.symbol AS registry_symbol, r.display_name AS registry_name, c.symbol AS column_symbol, c.display_name AS column_name
  FROM registry_column c JOIN registry r ON r.id = c.registry_id
  WHERE r.user_id = ? AND r.deleted_at IS NULL AND c.deleted_at IS NULL AND c.type = 'choice' AND json_extract(c.type_options, '$.dictionaryId') IS NOT NULL`;

const usageOf = (row: UsageRow): DictionaryUsage => ({ dictionaryId: row.dictionary_id, registrySymbol: row.registry_symbol, registryName: row.registry_name, columnSymbol: row.column_symbol, columnName: row.column_name });

export function bindColumnDictionaryLinks(tx: TransactionHandle): ColumnDictionaryLinks {
  const all = tx.prepare(`${USAGES} ORDER BY r.created_at, r.id, c.position, c.id`);
  const ofDictionary = tx.prepare(`${USAGES} AND json_extract(c.type_options, '$.dictionaryId') = ? ORDER BY r.created_at, r.id, c.position, c.id`);
  // Every column of the owner that names the dictionary, in a deleted registry too, so none is left pointing at nothing.
  const unpinColumns = tx.prepare(
    `UPDATE registry_column SET type_options = json_remove(type_options, '$.dictionaryId')
     WHERE json_extract(type_options, '$.dictionaryId') = ? AND registry_id IN (SELECT id FROM registry WHERE user_id = ?)`,
  );
  const raiseSchema = tx.prepare("UPDATE registry SET schema_revision = schema_revision + 1, updated_at = ? WHERE id = ? AND user_id = ?");

  return {
    usages: (ownerId) => (all.all(ownerId) as UsageRow[]).map(usageOf),
    unpin(ownerId, dictionaryId, nowIso): readonly DictionaryUsage[] {
      const rows = ofDictionary.all(ownerId, dictionaryId) as UsageRow[];
      unpinColumns.run(dictionaryId, ownerId);
      for (const registryId of new Set(rows.map((row) => row.registry_id))) raiseSchema.run(nowIso, registryId, ownerId);
      return rows.map(usageOf);
    },
  };
}
