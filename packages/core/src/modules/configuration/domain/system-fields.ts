// `Field.System.<symbol>` (Architektura §5.3; D25.1): values the application gives a widget, not
// data of the owner. A day is the day of the owner's zone, so "today" turns at the owner's midnight,
// whatever the zone of the server; `teraz` is the instant itself. Pure: the clock, the preferences
// and the version are passed in.
import { dayBefore, dayInZone } from "../../registries/public.js";

export const SYSTEM_FIELD_SYMBOLS = ["dzis", "wczoraj", "teraz", "strefa", "jezyk", "wersja"] as const;
export type SystemFieldSymbol = (typeof SYSTEM_FIELD_SYMBOLS)[number];

export type SystemFieldContext = Readonly<{ nowMs: number; timeZone: string; locale: string; appVersion: string }>;

export function systemFieldValue(symbol: SystemFieldSymbol, context: SystemFieldContext): string {
  switch (symbol) {
    case "dzis":
      return dayInZone(context.nowMs, context.timeZone);
    case "wczoraj":
      return dayBefore(dayInZone(context.nowMs, context.timeZone));
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
