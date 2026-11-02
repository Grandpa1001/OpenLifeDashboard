// The catalog of registries in the system preview (D32.1): `registry` and `registry_column`, the tables
// this module owns, with the columns of the preview only and the owner's rows only.
import { SYSTEM_TABLES, type SystemTableSource } from "@openlife/core/registries";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";
import { systemTableSource } from "../system-table-source.js";

const selectOf = (alias: string, columns: readonly string[]): string => columns.map((column) => `${alias}.${column}`).join(", ");

export function bindRegistrySystemTables(tx: TransactionHandle): Readonly<{ registry: SystemTableSource; registry_column: SystemTableSource }> {
  return {
    registry: systemTableSource(tx, {
      count: "SELECT count(*) AS n FROM registry r WHERE r.user_id = ?",
      select: `SELECT ${selectOf("r", SYSTEM_TABLES.registry)} FROM registry r WHERE r.user_id = ? ORDER BY r.created_at, r.id`,
      columns: SYSTEM_TABLES.registry,
      ownerParams: 1,
    }),
    registry_column: systemTableSource(tx, {
      count: "SELECT count(*) AS n FROM registry_column c JOIN registry r ON r.id = c.registry_id WHERE r.user_id = ?",
      select: `SELECT ${selectOf("c", SYSTEM_TABLES.registry_column)} FROM registry_column c JOIN registry r ON r.id = c.registry_id WHERE r.user_id = ? ORDER BY r.created_at, r.id, c.position, c.id`,
      columns: SYSTEM_TABLES.registry_column,
      ownerParams: 1,
    }),
  };
}
