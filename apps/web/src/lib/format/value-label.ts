// The label of a dictionary value on a page (Architektura §5.4; D24): the page carries the labels
// of its own symbols by column, hidden values too. A symbol without a label (the column has no
// dictionary, or the dictionary has no such value) is shown as it is stored.
import type { PageLabels } from "@openlife/contracts/http/dictionaries";
import type { CellValue } from "./cell-format.js";

export function valueLabel(labels: PageLabels, column: string, value: CellValue): string | null {
  if (typeof value !== "string" || !Object.hasOwn(labels, column)) return null;
  // Own keys only: a stored symbol such as `constructor` is a symbol, not a property of every object.
  const ofColumn = labels[column]!;
  return Object.hasOwn(ofColumn, value) ? ofColumn[value]! : null;
}
