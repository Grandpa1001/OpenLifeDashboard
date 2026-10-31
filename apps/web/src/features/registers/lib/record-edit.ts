// The change of a stored record in the form (Scope §5.6, Architektura §18.2; D23.3): what the form
// sends is only what differs from the record it was opened on (its base), and a conflict with a
// newer record on the server is shown field by field and resolved by taking that record as the new
// base without losing what the owner typed. Pure functions; the window does the I/O.
import { parseInput, valueText, type CellValue, type FormColumn } from "./record-input.js";

export type RecordValues = Readonly<Record<string, CellValue>>;

/** Two canonical values are the same value: a date-time is the same instant however it is written. */
export function sameValue(column: Pick<FormColumn, "type">, a: CellValue, b: CellValue): boolean {
  if (a === null || b === null) return a === b;
  if (column.type === "datetime" && typeof a === "string" && typeof b === "string") return Date.parse(a) === Date.parse(b);
  return a === b;
}

/** The columns whose value differs from the base, with their new values: the body of a change. */
export function changedValues(columns: readonly FormColumn[], base: RecordValues, values: RecordValues): Record<string, CellValue> {
  const changed: Record<string, CellValue> = {};
  for (const column of columns) {
    const value = values[column.symbol] ?? null;
    if (!sameValue(column, base[column.symbol] ?? null, value)) changed[column.symbol] = value;
  }
  return changed;
}

/** Every column has the same value on the server as in the form: a change that was already saved. */
export const sameRecord = (columns: readonly FormColumn[], server: RecordValues, values: RecordValues): boolean => Object.keys(changedValues(columns, server, values)).length === 0;

/** What the owner typed for a column, read as its value; an entry that is not a value yet is the text itself. */
export type Typed = Readonly<{ ok: true; value: CellValue } | { ok: false; text: string }>;

const typedOf = (column: FormColumn, text: string, timeZone: string): Typed => {
  const parsed = parseInput(column, text, timeZone);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, text };
};

export type ConflictRow = Readonly<{ column: FormColumn; server: CellValue; mine: Typed }>;

/** The fields whose value on the server differs from the form, in the order of the columns (makieta 21). */
export function conflictRows(columns: readonly FormColumn[], server: RecordValues, typed: ReadonlyMap<string, string>, timeZone: string): ConflictRow[] {
  return columns.flatMap((column) => {
    const serverValue = server[column.symbol] ?? null;
    const mine = typedOf(column, typed.get(column.symbol) ?? valueText(column, serverValue, timeZone), timeZone);
    return mine.ok && sameValue(column, serverValue, mine.value) ? [] : [{ column, server: serverValue, mine }];
  });
}

/**
 * The texts of the form after the newer record is loaded: a field the owner changed from the old
 * base keeps what was typed, every other field shows the newer value. A change the other session
 * made to a field the owner did not touch is therefore kept when the form is saved.
 */
export function rebaseTyped(columns: readonly FormColumn[], oldBase: RecordValues, newBase: RecordValues, typed: ReadonlyMap<string, string>, timeZone: string): Map<string, string> {
  const next = new Map<string, string>();
  for (const column of columns) {
    const before = valueText(column, oldBase[column.symbol] ?? null, timeZone);
    const text = typed.get(column.symbol) ?? before;
    next.set(column.symbol, text === before ? valueText(column, newBase[column.symbol] ?? null, timeZone) : text);
  }
  return next;
}

/** The name a record is called by in a label: the value of its first text column, or null when it has none. */
export function recordName(columns: readonly FormColumn[], values: RecordValues): string | null {
  for (const column of columns) {
    const value = values[column.symbol];
    if (column.type === "text" && typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
