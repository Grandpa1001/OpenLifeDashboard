// The labels of the dictionary values on one page of records (Architektura §5.4; D24.2): for each
// column that names a dictionary, the label of every symbol of the page the dictionary has, hidden
// values included. A symbol it does not have gets no label and is shown as it is; the stored text
// and the values of the page are never changed. One read of the lookup per such column.
import type { CellValue } from "../domain/column-rules.js";
import type { DictionaryLookup } from "../ports.js";

export type PageLabels = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A column of a page: the key its values are under, and its dictionary if it has one. */
export type LabelledColumn = Readonly<{ key: string; dictionaryId?: string | undefined }>;

export function pageLabels(lookup: DictionaryLookup, ownerId: string, columns: readonly LabelledColumn[], rows: readonly Readonly<Record<string, CellValue>>[]): PageLabels {
  const labels: Record<string, Readonly<Record<string, string>>> = {};
  for (const column of columns) {
    if (column.dictionaryId === undefined) continue;
    const symbols = [...new Set(rows.map((row) => row[column.key]).filter((value): value is string => typeof value === "string"))];
    if (symbols.length === 0) continue;
    const found = lookup.labels(ownerId, column.dictionaryId, symbols);
    if (found.size > 0) labels[column.key] = Object.fromEntries(found);
  }
  return labels;
}
