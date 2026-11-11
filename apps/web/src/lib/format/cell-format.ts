// A stored value as the owner reads it in a table (Scope §6.2), in the register page and in the widget: numbers with the decimals of the
// column, amounts with two, dates and times in the owner's language and zone. An empty value is
// an empty text; the table decides how to show emptiness and booleans, which need translations.
import { formatInstantDate, formatStoredDate, type DateFormat } from "./date-format.js";

export type CellValue = string | number | boolean | null;
/** What the format of a value needs to know of its column. */
export type FormatColumn = Readonly<{ type: string; typeOptions: Readonly<{ decimalPlaces?: number | undefined }> }>;

/** How the owner reads values: the language, the zone and the way a date is written (Architektura §14.2). */
export type Display = Readonly<{ locale: string; timeZone: string; dateFormat: DateFormat }>;

/**
 * An amount in units × 100 in the owner's language, exact for every safe integer: the units are
 * grouped as a bigint and the grosze are appended after the language's decimal separator, so no
 * division of a floating-point number rounds the last digits.
 */
function formatCents(cents: number, locale: string): string {
  const rest = Math.abs(cents) % 100;
  const units = (Math.abs(cents) - rest) / 100;
  const separator = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")?.value ?? ".";
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(BigInt(units));
  return `${cents < 0 ? "-" : ""}${grouped}${separator}${String(rest).padStart(2, "0")}`;
}

export function formatCell(column: FormatColumn, value: CellValue, display: Display): string {
  if (value === null) return "";
  switch (column.type) {
    case "number": {
      const places = column.typeOptions.decimalPlaces ?? 0;
      return typeof value === "number" ? new Intl.NumberFormat(display.locale, { minimumFractionDigits: places, maximumFractionDigits: places }).format(value) : String(value);
    }
    case "money":
      return typeof value === "number" && Number.isSafeInteger(value) ? formatCents(value, display.locale) : String(value);
    case "date":
      return (typeof value === "string" ? formatStoredDate(value, display.dateFormat) : null) ?? String(value);
    case "datetime": {
      const instant = typeof value === "string" ? Date.parse(value) : Number.NaN;
      if (Number.isNaN(instant)) return String(value);
      // The day in the owner's pattern, the time in the owner's language: "15.07.2026, 12:00".
      return `${formatInstantDate(instant, display.timeZone, display.dateFormat)}, ${new Intl.DateTimeFormat(display.locale, { timeStyle: "short", timeZone: display.timeZone }).format(instant)}`;
    }
    default:
      return String(value);
  }
}
