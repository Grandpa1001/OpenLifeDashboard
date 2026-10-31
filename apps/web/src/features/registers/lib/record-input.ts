// What the owner types into the form of a record, and the canonical value the API takes for it
// (Architektura §4.3, §5.4): an amount typed as `10,37` is `1037`, a date-time typed on the owner's
// wall is an ISO UTC instant. D15 takes the canonical form only; the conversion is made here, once.
import { zonedLocalToUtcIso, utcIsoToZonedLocal } from "./zoned-time.js";

export type FormColumn = Readonly<{
  symbol: string;
  displayName: string;
  type: "text" | "number" | "money" | "date" | "datetime" | "time" | "boolean" | "choice";
  typeOptions: Readonly<{ decimalPlaces?: number | undefined }>;
  defaultValue: string | number | boolean | null;
  required: boolean;
}>;

export type CellValue = string | number | boolean | null;
export type Parsed = Readonly<{ ok: true; value: CellValue }> | Readonly<{ ok: false }>;

/** The yes/no values of the select, as typed. */
export const BOOLEAN_TEXT = { yes: "true", no: "false" } as const;

/**
 * An amount in units × 100 as `units.cc`, exact for every safe integer: the remainder is exact on
 * integers, and the units are a whole division of a multiple of 100 (no rounding of a fraction).
 */
export function centsToText(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const rest = absolute % 100;
  return `${sign}${(absolute - rest) / 100}.${String(rest).padStart(2, "0")}`;
}

/** The default of a column as the form shows it before anything is typed. */
export function initialText(column: FormColumn, timeZone: string): string {
  const value = column.defaultValue;
  if (value === null) return "";
  switch (column.type) {
    case "boolean":
      return value === true ? BOOLEAN_TEXT.yes : BOOLEAN_TEXT.no;
    case "money":
      return typeof value === "number" ? centsToText(value) : "";
    case "datetime":
      return typeof value === "string" ? (utcIsoToZonedLocal(value, timeZone) ?? "") : "";
    default:
      return String(value);
  }
}

const NUMBER = /^[+-]?\d+(?:\.(\d+))?$/;
const MONEY = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Spaces between groups of digits go; a decimal comma is a point. */
const normalizeDecimal = (text: string): string => text.replace(/\s/g, "").replace(",", ".");

function isCalendarDate(text: string): boolean {
  const match = DATE.exec(text);
  if (match === null) return false;
  const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * An amount typed in units (`10,37`) as units × 100, computed on the digits as text: a product of
 * floating-point numbers would lose grosze before the safe-integer bound is reached.
 */
function parseMoney(text: string): Parsed {
  const match = MONEY.exec(normalizeDecimal(text));
  if (match === null) return { ok: false };
  const cents = BigInt(`${match[2] ?? ""}${(match[3] ?? "").padEnd(2, "0")}`);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false };
  const value = Number(cents);
  return { ok: true, value: match[1] === "-" ? -value : value };
}

/** A number with at most the decimal places of its column; more places are refused, never rounded away. */
function parseNumber(text: string, decimalPlaces: number): Parsed {
  const normalized = normalizeDecimal(text);
  const match = NUMBER.exec(normalized);
  const value = Number(normalized);
  if (match === null || !Number.isFinite(value) || (match[1] ?? "").length > decimalPlaces) return { ok: false };
  return { ok: true, value };
}

/**
 * The canonical value of what was typed. Nothing typed is `null`, which the server refuses for a
 * required column; a text that is no value of the type is `ok: false` and is not sent. Text and
 * choice are sent as typed: whether white space counts as empty is the rule of the registry.
 */
export function parseInput(column: FormColumn, typed: string, timeZone: string): Parsed {
  if (column.type === "text" || column.type === "choice") return { ok: true, value: typed === "" ? null : typed };
  const text = typed.trim();
  if (text === "") return { ok: true, value: null };
  switch (column.type) {
    case "number":
      return parseNumber(text, column.typeOptions.decimalPlaces ?? 0);
    case "money":
      return parseMoney(text);
    case "boolean":
      return text === BOOLEAN_TEXT.yes ? { ok: true, value: true } : text === BOOLEAN_TEXT.no ? { ok: true, value: false } : { ok: false };
    case "date":
      return isCalendarDate(text) ? { ok: true, value: text } : { ok: false };
    case "time":
      return TIME.test(text) ? { ok: true, value: text } : { ok: false };
    case "datetime": {
      const instant = zonedLocalToUtcIso(text, timeZone);
      return instant === null ? { ok: false } : { ok: true, value: instant };
    }
  }
}
