// RegistryStore on the handle of a unit of work (Architektura §4.2, §4.3, §5.1; D14.2): the catalog
// in `registry` and `registry_column` and the table `reg_<symbol>`. The catalog rows and the DDL are
// statements of one transaction, so a table that cannot be created leaves no catalog row behind, and
// a catalog row that cannot be written leaves no table.
import { checkSymbol, tableNameOf, type ColumnType, type NewRegistryRecord, type RegistryStore, type StoredColumn, type StoredRegistry } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { registryDdl } from "./registry-ddl.js";

type RegistryRow = {
  id: string;
  user_id: string;
  symbol: string;
  display_name: string;
  table_name: string;
  schema_revision: number;
  data_revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
type ColumnRow = { id: string; symbol: string; display_name: string; type: ColumnType; type_options: string; default_value: string | null; required: number; position: number };

export function bindRegistryStore(tx: TransactionHandle): RegistryStore {
  const count = tx.prepare("SELECT count(*) AS n FROM registry WHERE user_id = ? AND deleted_at IS NULL");
  const symbols = tx.prepare("SELECT symbol FROM registry WHERE user_id = ?");
  const insertRegistry = tx.prepare(
    `INSERT INTO registry (id, user_id, symbol, display_name, table_name, schema_revision, data_revision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, NULL)`,
  );
  const insertColumn = tx.prepare(
    `INSERT INTO registry_column (id, registry_id, symbol, display_name, type, type_options, default_value, required, position, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const byOwnerAndSymbol = tx.prepare("SELECT * FROM registry WHERE user_id = ? AND symbol = ?");
  const live = tx.prepare("SELECT * FROM registry WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at, id");
  const columnsOf = tx.prepare("SELECT id, symbol, display_name, type, type_options, default_value, required, position FROM registry_column WHERE registry_id = ? AND deleted_at IS NULL ORDER BY position, id");

  const stored = (row: RegistryRow): StoredRegistry => ({
    id: row.id,
    ownerId: row.user_id,
    symbol: row.symbol,
    displayName: row.display_name,
    tableName: row.table_name,
    schemaRevision: row.schema_revision,
    dataRevision: row.data_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    columns: (columnsOf.all(row.id) as ColumnRow[]).map(
      (column): StoredColumn => ({
        id: column.id,
        symbol: column.symbol,
        displayName: column.display_name,
        type: column.type,
        typeOptions: JSON.parse(column.type_options) as StoredColumn["typeOptions"],
        defaultValue: column.default_value === null ? null : (JSON.parse(column.default_value) as StoredColumn["defaultValue"]),
        required: column.required === 1,
        position: column.position,
      }),
    ),
  });

  return {
    activeCount: (ownerId) => (count.get(ownerId) as { n: number }).n,
    takenSymbols: (ownerId) => new Set((symbols.all(ownerId) as { symbol: string }[]).map((row) => row.symbol)),
    insert(record: NewRegistryRecord): void {
      const { definition } = record;
      if (record.columnIds.length !== definition.columns.length) throw new TypeError("a column identifier is needed for every column");
      // The statements are built first: a name that is not safe fails here, before anything is written.
      const ddl = registryDdl(definition);
      const taken = new Set((symbols.all(record.ownerId) as { symbol: string }[]).map((row) => row.symbol));
      const issue = checkSymbol(definition.symbol, "registry", taken);
      if (issue !== null) throw new TypeError(`the registry symbol was refused: ${issue}`);

      insertRegistry.run(record.id, record.ownerId, definition.symbol, definition.displayName, tableNameOf(definition.symbol), record.nowIso, record.nowIso);
      definition.columns.forEach((column, index) => {
        insertColumn.run(
          record.columnIds[index],
          record.id,
          column.symbol,
          column.displayName,
          column.type,
          JSON.stringify(column.typeOptions),
          column.defaultValue === null ? null : JSON.stringify(column.defaultValue),
          column.required ? 1 : 0,
          column.position,
          record.nowIso,
        );
      });
      tx.prepare(ddl.table).run();
      for (const index of ddl.indexes) tx.prepare(index).run();
    },
    find: (ownerId, symbol) => {
      const row = byOwnerAndSymbol.get(ownerId, symbol) as RegistryRow | undefined;
      return row === undefined ? null : stored(row);
    },
    list: (ownerId) => (live.all(ownerId) as RegistryRow[]).map(stored),
  };
}
