// D36.1 — the time of the clock (Scope §6.3, S13; F02 `fixedClockCases`): what it shows at the two
// moments of the change of time of F02 in Warsaw and New York, in 12 hours with AM/PM, its date; and
// its ticker, at the boundary of a second or a minute, at once when the tab comes back, and nothing left
// after it stops.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clockReading, startTicker, untilNextTick, zoneOf, type TickerHost } from "../../../apps/web/src/features/dashboard/lib/clock.js";
import { clockConfigSchema } from "../../../packages/widgets/dist/views.js";

const F02 = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../fixtures/books/books-v1.expected.json"), "utf8")) as { fixedClockCases: Array<{ nowIso: string; "Europe/Warsaw": string; "America/New_York": string }> };
const display = { locale: "pl", timeZone: "Europe/Warsaw" };
const clock = (patch: Record<string, unknown> = {}) => clockConfigSchema.parse({ v: 1, ...patch });

describe("D36.1 what the clock shows", () => {
  it("the two moments of F02: Warsaw by the owner's zone and New York by its own", () => {
    expect(F02.fixedClockCases).toHaveLength(2);
    for (const moment of F02.fixedClockCases) {
      const now = Date.parse(moment.nowIso);
      expect(clockReading(now, clock({ showDate: false }), display).time, moment.nowIso).toBe(moment["Europe/Warsaw"]);
      expect(clockReading(now, clock({ timezone: "America/New_York", showDate: false }), display).time, moment.nowIso).toBe(moment["America/New_York"]);
    }
  });

  it("12 hours with AM/PM, seconds, the date in the owner's language, and the owner's zone followed", () => {
    const now = Date.parse("2026-03-29T13:05:09Z");
    expect(clockReading(now, clock({ format: "12h", showSeconds: true, timezone: "America/New_York" }), { locale: "en-US", timeZone: "UTC" }).time).toBe("09:05:09 AM");
    expect(clockReading(now, clock(), display).date).toBe("niedziela, 29 marca 2026");
    expect(clockReading(now, clock({ showDate: false }), display).date).toBeNull();
    expect(zoneOf(clock(), "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(zoneOf(clock({ timezone: "Europe/London" }), "Asia/Tokyo")).toBe("Europe/London");
  });

  it("the configuration of F01 and its defaults; an unknown zone and a long caption are refused", () => {
    expect(clockConfigSchema.parse({ v: 1 })).toEqual({ v: 1, timezone: "owner", label: "", format: "24h", showSeconds: false, showDate: true });
    for (const timezone of ["Mars/Olympus", "", "Europe/Warsaw "]) expect(clockConfigSchema.safeParse({ v: 1, timezone }).success, timezone).toBe(false);
    expect(clockConfigSchema.safeParse({ v: 1, label: "x".repeat(41) }).success).toBe(false);
    expect(clockConfigSchema.safeParse({ v: 1, label: "x".repeat(40) }).success).toBe(true);
    expect(clockConfigSchema.safeParse({ v: 1, format: "24" }).success).toBe(false);
  });
});

/** A clock of the test: time moves only when it is told, and the timers and listeners can be counted. */
function fakeHost(start: number) {
  let now = start;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const resumers = new Set<() => void>();
  const host: TickerHost = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    onResume: (run) => {
      resumers.add(run);
      return () => resumers.delete(run);
    },
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { host, advance, timers, resumers, jump: (ms: number) => void (now += ms), resume: () => [...resumers].forEach((run) => run()) };
}

describe("D36.1 the ticker of the clock", () => {
  it("waits to the next second or minute", () => {
    expect(untilNextTick(Date.parse("2026-03-29T00:30:12.250Z"), true)).toBe(750);
    expect(untilNextTick(Date.parse("2026-03-29T00:30:12.250Z"), false)).toBe(47_750);
  });

  it("ticks at once and then at each minute boundary, again at once when the tab comes back, and leaves nothing when it stops", () => {
    const start = Date.parse("2026-03-29T00:30:12.250Z");
    const fake = fakeHost(start);
    const ticks: number[] = [];
    const stop = startTicker(fake.host, false, (now) => ticks.push(now));
    expect(ticks).toEqual([start]);
    fake.advance(47_750 + 60_000);
    expect(ticks.slice(1).map((at) => new Date(at).toISOString())).toEqual(["2026-03-29T00:31:00.000Z", "2026-03-29T00:32:00.000Z"]);
    expect(fake.timers.size).toBe(1);
    // A tab in the background: its timer was late; coming back shows the time at once.
    fake.jump(5 * 60_000 + 7_000);
    fake.resume();
    expect(new Date(ticks.at(-1)!).toISOString()).toBe("2026-03-29T00:37:07.000Z");
    expect(fake.timers.size).toBe(1);
    stop();
    expect(fake.timers.size).toBe(0);
    expect(fake.resumers.size).toBe(0);
    fake.advance(10 * 60_000);
    fake.resume();
    expect(ticks).toHaveLength(4);
  });

  it("with seconds ticks at each second", () => {
    const fake = fakeHost(Date.parse("2026-03-29T00:30:12.250Z"));
    const ticks: number[] = [];
    const stop = startTicker(fake.host, true, (now) => ticks.push(now));
    fake.advance(2_750);
    expect(ticks.slice(1).map((at) => new Date(at).toISOString().slice(17))).toEqual(["13.000Z", "14.000Z", "15.000Z"]);
    stop();
  });
});
