// A value of a record as SQLite stores it and back (Architektura §4.3): yes/no is 0 or 1, every
// other type is stored as its canonical form. Shared by the records and the rebuild of a table, so
// a rebuilt row is stored exactly as a written one.
import type { CellValue, StoredColumn } from "@openlife/core/registries";

export const encodeCell = (column: Pick<StoredColumn, "type">, value: CellValue | undefined): unknown => {
  if (value === undefined || value === null) return null;
  return column.type === "boolean" ? (value === true ? 1 : 0) : value;
};

export const decodeCell = (column: Pick<StoredColumn, "type">, value: unknown): CellValue => {
  if (value === null || value === undefined) return null;
  return column.type === "boolean" ? value === 1 : (value as CellValue);
};
