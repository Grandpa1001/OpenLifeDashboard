// Column types, their options and the default value of a column (Architektura §4.3). The codes of
// the types are stable in the API, the database and the export; the labels are the web app's.
export const COLUMN_TYPES = ["text", "number", "money", "date", "datetime", "time", "boolean", "choice"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const DECIMAL_PLACES_MAX = 6;
const DICTIONARY_ID_MAX_CHARS = 64;

export type ColumnTypeOptions = Readonly<{ decimalPlaces?: number; dictionaryId?: string }>;
/** A stored or default value of a cell: what the API and the export carry (money in units × 100). */
export type CellValue = string | number | boolean | null;

export const isColumnType = (value: unknown): value is ColumnType => typeof value === "string" && (COLUMN_TYPES as readonly string[]).includes(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The options of a type, or null when they are wrong: an unknown key, a value out of range, an
 * option of another type. A number without `decimalPlaces` has none (0); the normalized options
 * always carry what the type needs.
 */
export function normalizeTypeOptions(type: ColumnType, options: unknown): ColumnTypeOptions | null {
  if (!isPlainObject(options)) return null;
  const keys = Object.keys(options);
  switch (type) {
    case "number": {
      if (keys.some((key) => key !== "decimalPlaces")) return null;
      const places = options["decimalPlaces"] ?? 0;
      return typeof places === "number" && Number.isInteger(places) && places >= 0 && places <= DECIMAL_PLACES_MAX ? { decimalPlaces: places } : null;
    }
    case "choice": {
      if (keys.some((key) => key !== "dictionaryId")) return null;
      const id = options["dictionaryId"];
      if (id === undefined) return {};
      return typeof id === "string" && id.length > 0 && id.length <= DICTIONARY_ID_MAX_CHARS ? { dictionaryId: id } : null;
    }
    default:
      return keys.length === 0 ? {} : null;
  }
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function decimalsOk(value: number, places: number): boolean {
  const scaled = Math.round(value * 10 ** places);
  return Math.abs(value * 10 ** places - scaled) < 1e-6 * Math.max(1, Math.abs(scaled));
}

const codePoints = (text: string): number => Array.from(text).length;

/**
 * Whether `value` is a well-formed value of a column of `type` in the canonical form of the API
 * (money in units × 100, dates as `YYYY-MM-DD`, date-times as ISO 8601 UTC, times as `HH:MM`). Null
 * is always well-formed here; whether it is allowed is the column's `required`. Text and choice are
 * limited in code points. The same rule serves the default of a column and the value of a record.
 */
export function isValidCellValue(type: ColumnType, options: ColumnTypeOptions, value: unknown, textMaxCodePoints: number): value is CellValue {
  if (value === null) return true;
  switch (type) {
    case "text":
      return typeof value === "string" && codePoints(value) <= textMaxCodePoints;
    case "choice":
      return typeof value === "string" && value.length > 0 && codePoints(value) <= textMaxCodePoints;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && decimalsOk(value, options.decimalPlaces ?? 0);
    case "money":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "date": {
      const match = typeof value === "string" ? DATE.exec(value) : null;
      return match !== null && isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    case "datetime": {
      const match = typeof value === "string" ? DATETIME.exec(value) : null;
      if (match === null) return false;
      const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      return isCalendarDate(year, month, day) && hour <= 23 && minute <= 59 && second <= 59;
    }
    case "time":
      return typeof value === "string" && TIME.test(value);
  }
}

/** Whether `value` may be the default of a column: the rule of a value of that column. */
export const isValidDefault = isValidCellValue;
