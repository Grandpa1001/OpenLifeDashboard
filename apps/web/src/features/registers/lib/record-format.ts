// A stored value as the owner reads it in the table (Scope §6.2): numbers with the decimals of the
// column, amounts with two, dates and times in the owner's language and zone. An empty value is
// an empty text; the table decides how to show emptiness and booleans, which need translations.
import type { CellValue, FormColumn } from "./record-input.js";

export type Display = Readonly<{ locale: string; timeZone: string }>;

export function formatCell(column: FormColumn, value: CellValue, display: Display): string {
  if (value === null) return "";
  switch (column.type) {
    case "number": {
      const places = column.typeOptions.decimalPlaces ?? 0;
      return typeof value === "number" ? new Intl.NumberFormat(display.locale, { minimumFractionDigits: places, maximumFractionDigits: places }).format(value) : String(value);
    }
    case "money":
      return typeof value === "number" ? new Intl.NumberFormat(display.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100) : String(value);
    case "date": {
      const instant = typeof value === "string" ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
      return Number.isNaN(instant) ? String(value) : new Intl.DateTimeFormat(display.locale, { dateStyle: "medium", timeZone: "UTC" }).format(instant);
    }
    case "datetime": {
      const instant = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isNaN(instant) ? String(value) : new Intl.DateTimeFormat(display.locale, { dateStyle: "medium", timeStyle: "short", timeZone: display.timeZone }).format(instant);
    }
    default:
      return String(value);
  }
}
