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

const centsToText = (cents: number): string => {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
};

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

const NUMBER = /^[+-]?\d+(\.\d+)?$/;
const MONEY = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;

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
    case "number": {
      const normalized = text.replace(/\s/g, "").replace(",", ".");
      const value = Number(normalized);
      return NUMBER.test(normalized) && Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    case "money": {
      const match = MONEY.exec(text.replace(/\s/g, "").replace(",", "."));
      if (match === null) return { ok: false };
      const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
      const signed = match[1] === "-" ? -cents : cents;
      return Number.isSafeInteger(signed) ? { ok: true, value: signed } : { ok: false };
    }
    case "boolean":
      return text === BOOLEAN_TEXT.yes ? { ok: true, value: true } : text === BOOLEAN_TEXT.no ? { ok: true, value: false } : { ok: false };
    case "datetime": {
      const instant = zonedLocalToUtcIso(text, timeZone);
      return instant === null ? { ok: false } : { ok: true, value: instant };
    }
    default:
      return { ok: true, value: text };
  }
}
