// A date as the owner chose to read it (Architektura §14.2, `dateFormat`; D42.2): one of three patterns
// over the same year, month and day. It changes what is shown and nothing that is stored or typed.
import { DEFAULT_DATE_FORMAT, type DateFormat } from "@openlife/contracts/http/setup";

export { DEFAULT_DATE_FORMAT, type DateFormat };

const pad = (value: number): string => String(value).padStart(2, "0");

/** The pattern filled with a year, a month and a day. */
export function formatYmd(year: number, month: number, day: number, pattern: DateFormat): string {
  const y = String(year).padStart(4, "0");
  switch (pattern) {
    case "YYYY-MM-DD":
      return `${y}-${pad(month)}-${pad(day)}`;
    case "MM/DD/YYYY":
      return `${pad(month)}/${pad(day)}/${y}`;
    case "DD.MM.YYYY":
      return `${pad(day)}.${pad(month)}.${y}`;
  }
}

/** The day an instant falls on in a zone, in the pattern. */
export function formatInstantDate(instantMs: number, timeZone: string, pattern: DateFormat): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instantMs);
  const part = (type: string): number => Number(parts.find((each) => each.type === type)?.value);
  return formatYmd(part("year"), part("month"), part("day"), pattern);
}

const STORED_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A stored date (`YYYY-MM-DD`) in the pattern, or null when the text is not one. */
export function formatStoredDate(value: string, pattern: DateFormat): string | null {
  const match = STORED_DATE.exec(value);
  return match === null ? null : formatYmd(Number(match[1]), Number(match[2]), Number(match[3]), pattern);
}
