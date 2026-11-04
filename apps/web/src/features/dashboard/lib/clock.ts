// The time of a clock widget (Scope §6.3; D36.1): what it shows at an instant, and when it has to
// change. `Intl` does the zones and their changes of time (DST); nothing here adds hours by hand.
import { OWNER_ZONE, type ClockConfig } from "@openlife/widgets/views";

export type ClockReading = Readonly<{ time: string; date: string | null; zone: string; instant: string }>;

/** The zone a clock shows: its own, or the owner's for `owner` (followed when the owner changes it). */
export const zoneOf = (config: Pick<ClockConfig, "timezone">, ownerZone: string): string => (config.timezone === OWNER_ZONE ? ownerZone : config.timezone);

/** What the clock shows at `now`, in its zone and the language of the owner. */
export function clockReading(now: number, config: Pick<ClockConfig, "timezone" | "format" | "showSeconds" | "showDate">, display: Readonly<{ locale: string; timeZone: string }>): ClockReading {
  const zone = zoneOf(config, display.timeZone);
  const time = new Intl.DateTimeFormat(display.locale, {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    ...(config.showSeconds ? { second: "2-digit" } : {}),
    hourCycle: config.format === "12h" ? "h12" : "h23",
  }).format(now);
  const date = config.showDate ? new Intl.DateTimeFormat(display.locale, { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now) : null;
  return { time, date, zone, instant: new Date(now).toISOString() };
}

/** Milliseconds from `now` to the next second, or the next minute, when the shown time changes. Zones differ by whole minutes, so the boundary is the same in every zone. */
export function untilNextTick(now: number, showSeconds: boolean): number {
  const unit = showSeconds ? 1000 : 60_000;
  return unit - (now % unit);
}

/** The timers and the page events a ticker uses; the browser's by default, a fake one in tests. */
export type TickerHost = Readonly<{
  now: () => number;
  setTimeout: (run: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  /** Calls `run` when the tab comes back or takes the focus; returns how to stop. */
  onResume: (run: () => void) => () => void;
}>;

/**
 * Calls `tick` at once, then at every boundary of the shown time, and at once again when the tab comes
 * back (a timer of a tab in the background is late or stopped). One timer at a time, never an interval;
 * the returned stop clears the timer and the listeners, so a removed clock leaves nothing behind.
 */
export function startTicker(host: TickerHost, showSeconds: boolean, tick: (now: number) => void): () => void {
  let timer: number | null = null;
  let stopped = false;
  const schedule = (): void => {
    const now = host.now();
    tick(now);
    if (timer !== null) host.clearTimeout(timer);
    timer = host.setTimeout(() => {
      timer = null;
      if (!stopped) schedule();
    }, untilNextTick(now, showSeconds));
  };
  schedule();
  const stopResume = host.onResume(() => {
    if (!stopped) schedule();
  });
  return () => {
    stopped = true;
    if (timer !== null) host.clearTimeout(timer);
    timer = null;
    stopResume();
  };
}
