// `Field.System.<symbol>` (Architektura §5.3; D25.1): values the application gives a widget, not
// data of the owner. A day is the day of the owner's zone, so "today" turns at the owner's midnight,
// whatever the zone of the server; `teraz` is the instant itself. Pure: the clock, the preferences
// and the version are passed in.
export const SYSTEM_FIELD_SYMBOLS = ["dzis", "wczoraj", "teraz", "strefa", "jezyk", "wersja"] as const;
export type SystemFieldSymbol = (typeof SYSTEM_FIELD_SYMBOLS)[number];

export type SystemFieldContext = Readonly<{ nowMs: number; timeZone: string; locale: string; appVersion: string }>;

/** The calendar day `YYYY-MM-DD` of an instant in a zone. */
function dayIn(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instantMs);
  const part = (type: string): string => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** The day before a calendar day, counted on the calendar (a day of 23 or 25 hours is still one day). */
function dayBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

export function systemFieldValue(symbol: SystemFieldSymbol, context: SystemFieldContext): string {
  switch (symbol) {
    case "dzis":
      return dayIn(context.nowMs, context.timeZone);
    case "wczoraj":
      return dayBefore(dayIn(context.nowMs, context.timeZone));
    case "teraz":
      return new Date(context.nowMs).toISOString();
    case "strefa":
      return context.timeZone;
    case "jezyk":
      return context.locale;
    case "wersja":
      return context.appVersion;
  }
}
