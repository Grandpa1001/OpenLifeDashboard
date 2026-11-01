// The plan of a change of a column's type for the rebuild of its table (Architektura §4.5 p. 5–7,
// §5.2; D27.1). Pure: the column as it will be, and what each stored value becomes. A value that
// converts is kept converted; one that does not is empty in a column that is not required and the
// replacement of the plan in one that is. A required column whose values would be lost without a
// replacement is blocked before this plan is made (`assessChange`), so the plan never leaves a
// required cell empty. The failures are counted, to be checked against the report of the preview.
import { convertCell, type ConversionContext } from "./convert.js";
import type { CellValue } from "./column-rules.js";
import type { NewColumn } from "./definition.js";
import type { StructureChange } from "./structure-change.js";

/** A column of the catalog: its definition and its permanent identifier. */
type CatalogColumn = NewColumn & Readonly<{ id: string }>;

export type CellRewrite = Readonly<{ value: CellValue; failed: boolean }>;
export type TypeChangePlan = Readonly<{ target: CatalogColumn; rewrite: (value: CellValue) => CellRewrite }>;

export function planTypeChange(column: CatalogColumn, change: Extract<StructureChange, { kind: "changeType" }>, context: ConversionContext): TypeChangePlan {
  const to = { type: change.type, typeOptions: change.typeOptions };
  // The default of the column is a value of the old type too: one that does not convert is dropped, not invented.
  const defaultValue = convertCell(column.defaultValue, column, to, context);
  const target: CatalogColumn = { ...column, type: change.type, typeOptions: change.typeOptions, required: change.required, defaultValue: defaultValue.ok ? defaultValue.value : null };
  return {
    target,
    rewrite(value) {
      const converted = convertCell(value, column, to, context);
      const kept = converted.ok ? converted.value : null;
      return { value: kept === null && change.required ? change.replacement : kept, failed: !converted.ok };
    },
  };
}
