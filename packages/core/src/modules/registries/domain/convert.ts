// The conversion of a stored value to another column type (Architektura §4.3, §4.5 p. 7–9, §5.2;
// D26.1). Pure functions on the canonical form, never SQLite's own casts: a value either becomes a
// valid value of the new type exactly, or it does not convert. Nothing is rounded, a date is a real
// day, a date-time keeps its instant and an amount stays an integer of grosze. Null stays null.
import { isValidCellValue, type CellValue, type ColumnType, type ColumnTypeOptions } from "./column-rules.js";
import { dayInZone, startOfDayInZone } from "./zoned-day.js";

export type ConversionColumn = Readonly<{ type: ColumnType; typeOptions: ColumnTypeOptions }>;
/** The owner's zone decides the day of a date-time and the midnight of a date; texts are limited as records are. */
export type ConversionContext = Readonly<{ timeZone: string; textMaxCodePoints: number }>;
export type Conversion = Readonly<{ ok: true; value: CellValue }> | Readonly<{ ok: false }>;

const TEXTUAL: ReadonlySet<ColumnType> = new Set(["text", "choice"]);

/** The pairs of types a column may change between, besides any type to text or choice and text or choice to any type. */
const PAIRS: ReadonlySet<string> = new Set(["number>number", "number>money", "money>number", "money>money", "boolean>number", "boolean>boolean", "date>date", "date>datetime", "datetime>date", "datetime>datetime", "time>time"]);

export function isConversionSupported(from: ColumnType, to: ColumnType): boolean {
  return TEXTUAL.has(from) || TEXTUAL.has(to) || PAIRS.has(`${from}>${to}`);
}

const FAILED: Conversion = { ok: false };
const NUMBER = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const ZONED_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](\d{2}):(\d{2}))$/i;
const BOOLEAN_WORDS: Readonly<Record<string, boolean>> = { true: true, false: false, "1": true, "0": false, tak: true, nie: false, yes: true, no: false };

/** A typed number with spaces between digit groups and a decimal comma, as the canonical `[-]digits[.digits]`. */
function decimalText(text: string): RegExpExecArray | null {
  const compact = text.trim().replace(/[\s\u00a0\u202f]/g, "");
  const normalized = compact.includes(",") && !compact.includes(".") ? compact.replace(",", ".") : compact;
  return NUMBER.exec(normalized);
}

/** A number written without an exponent and without digits it does not have. One formatter for the module: making one per value cost 0.7 s for 50 000 values (D27.1). */
const PLAIN_NUMBER = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 20 });
const plainNumber = (value: number): string => PLAIN_NUMBER.format(value);

/** Grosze as `[-]units.cc`, exact for every safe integer. */
function centsText(cents: number): string {
  const rest = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}${(Math.abs(cents) - rest) / 100}.${String(rest).padStart(2, "0")}`;
}

/** An amount from a decimal text with at most two places, computed on the digits so no grosz is lost. */
function centsOf(match: RegExpExecArray): number | null {
  const fraction = match[3] ?? "";
  if (fraction.replace(/0+$/, "").length > 2) return null;
  const cents = BigInt(`${match[2]}${fraction.padEnd(2, "0").slice(0, 2)}`);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return match[1] === "-" ? -Number(cents) : Number(cents);
}

/** A number from a decimal text, refused when it has more places than the column keeps. */
function numberOf(match: RegExpExecArray, places: number): number | null {
  if ((match[3] ?? "").replace(/0+$/, "").length > places) return null;
  const value = Number(`${match[1]}${match[2]}${match[3] === undefined ? "" : `.${match[3]}`}`);
  return Number.isFinite(value) ? value : null;
}

/** A date-time typed with its zone (`Z` or an offset), as the instant in UTC; without a zone the instant is not known. */
function instantOf(text: string): string | null {
  const match = ZONED_DATETIME.exec(text.trim());
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const second = Number(match[6] ?? "0");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  if (match[9] !== undefined && (Number(match[9]) > 23 || Number(match[10]) > 59)) return null;
  const instant = Date.parse(`${match.slice(1, 4).join("-")}T${match[4]}:${match[5]}:${String(second).padStart(2, "0")}.${(match[7] ?? "0").padEnd(3, "0")}${match[8]!.toUpperCase()}`);
  return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

/** A stored value as text: the canonical form of its type (numbers without an exponent, amounts as units.cc, yes/no as true/false). */
function textOf(value: Exclude<CellValue, null>, from: ConversionColumn): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return from.type === "money" ? centsText(value) : plainNumber(value);
  return value;
}

function fromText(text: string, to: ConversionColumn): CellValue | undefined {
  switch (to.type) {
    case "text":
      return text;
    case "choice":
      return text === "" ? undefined : text;
    case "number": {
      const match = decimalText(text);
      return match === null ? undefined : (numberOf(match, to.typeOptions.decimalPlaces ?? 0) ?? undefined);
    }
    case "money": {
      const match = decimalText(text);
      return match === null ? undefined : (centsOf(match) ?? undefined);
    }
    case "boolean":
      return BOOLEAN_WORDS[text.trim().toLowerCase()];
    case "date":
    case "time":
      return text.trim();
    case "datetime":
      return instantOf(text) ?? undefined;
  }
}

/** The value of `from` as a value of `to`, or the fact that it does not convert. */
export function convertCell(value: CellValue, from: ConversionColumn, to: ConversionColumn, context: ConversionContext): Conversion {
  if (value === null) return { ok: true, value: null };
  if (!isConversionSupported(from.type, to.type)) return FAILED;
  let converted: CellValue | undefined;
  if (TEXTUAL.has(to.type) || TEXTUAL.has(from.type)) {
    converted = fromText(textOf(value, from), to);
  } else if (from.type === to.type && from.type !== "number") {
    converted = value;
  } else if (from.type === "boolean") {
    converted = value === true ? 1 : 0;
  } else if (from.type === "date" && to.type === "datetime") {
    const start = typeof value === "string" ? startOfDayInZone(value, context.timeZone) : null;
    converted = start === null ? undefined : new Date(start).toISOString();
  } else if (from.type === "datetime" && to.type === "date") {
    const instant = typeof value === "string" ? Date.parse(value) : Number.NaN;
    converted = Number.isNaN(instant) ? undefined : dayInZone(instant, context.timeZone);
  } else if (typeof value === "number") {
    // number → number or money, money → number: through the exact decimal text of the value.
    const match = decimalText(from.type === "money" ? centsText(value) : plainNumber(value));
    converted = match === null ? undefined : to.type === "money" ? (centsOf(match) ?? undefined) : (numberOf(match, to.typeOptions.decimalPlaces ?? 0) ?? undefined);
  }
  // The result must be a value the new column takes, as a record would be checked.
  return converted !== undefined && isValidCellValue(to.type, to.typeOptions, converted, context.textMaxCodePoints) ? { ok: true, value: converted } : FAILED;
}
