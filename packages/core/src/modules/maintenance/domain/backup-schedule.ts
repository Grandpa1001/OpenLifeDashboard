// When the nightly copy is due (Architektura §11.3.2, §14 `backup.time`; D49.2). Pure: it is given the moment, the
// zone of the owner, the time of day and the start of the last finished nightly copy, and says whether a copy is
// due now or when the next slot comes; reading the folder and taking the copy are other modules' business.
//
// A slot is the first moment of an owner's day at which the wall clock shows the configured time. Where the clock
// jumps over that time (spring) the slot is the end of the jump, the nearest valid moment; where the time happens
// twice (autumn) the slot is its first occurrence, so the second pass does not make a second copy.
//  - Due: the latest slot that has already come is not yet covered by the last copy: the last copy is neither
//    later than that slot nor made on the same day of the owner. So after a downtime exactly one copy is due,
//    whatever number of slots was missed, and one day never gets two nightly copies: not after a catch-up, not
//    after the clock goes back, not after the owner moves the time or the zone. A copy already made is never
//    withdrawn by any of them.
import { dayBefore, dayInZone, startOfDayInZone } from "../../registries/public.js";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
/** The clock moves by at most this much at a change in the tz database; the search for a slot starts that early. */
const MAX_SHIFT_MS = 3 * 60 * MINUTE_MS;
/** The search walks a minute at a time, as a zone can jump by half an hour; a day and the room before it is the most it needs. */
const MAX_SEARCH_STEPS = (24 * 60 * MINUTE_MS + MAX_SHIFT_MS) / MINUTE_MS;

export type NightlyDecision = Readonly<{ due: true; slotAtMs: number }> | Readonly<{ due: false; nextAtMs: number }>;

export type NightlyInputs = Readonly<{
  nowMs: number;
  /** IANA name of the zone of the owner. */
  timeZone: string;
  /** `HH:MM` on the wall clock of that zone. */
  time: string;
  /** `startedAt` of the newest finished nightly copy of this installation, or null when there is none. */
  lastNightlyAt: string | null;
}>;

/** Minutes since the midnight of the wall clock of a zone. */
function minuteOfDay(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(instantMs);
  const part = (type: string): number => Number(parts.find((each) => each.type === type)?.value ?? "0");
  return part("hour") * 60 + part("minute");
}

function dayAfter(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

/** The slot of an owner's day: the first moment of it whose wall clock is at or past `minutes`. */
function slotOfDay(day: string, minutes: number, timeZone: string): number {
  const start = startOfDayInZone(day, timeZone);
  if (start === null) throw new RangeError(`No such calendar day: ${day}`);
  let instant = Math.max(start, start + minutes * MINUTE_MS - MAX_SHIFT_MS);
  for (let steps = 0; steps < MAX_SEARCH_STEPS; steps += 1) {
    if (dayInZone(instant, timeZone) === day && minuteOfDay(instant, timeZone) >= minutes) return instant;
    instant += MINUTE_MS;
  }
  throw new RangeError(`The day ${day} has no moment at ${minutes} minutes in ${timeZone}`);
}

function parseTime(time: string): number {
  const match = TIME.exec(time);
  if (match === null) throw new RangeError(`Not a time of day HH:MM: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function decideNightlyBackup(inputs: NightlyInputs): NightlyDecision {
  const minutes = parseTime(inputs.time);
  const { nowMs, timeZone } = inputs;
  const today = dayInZone(nowMs, timeZone);
  const slotToday = slotOfDay(today, minutes, timeZone);
  const reached = slotToday <= nowMs ? { day: today, at: slotToday } : { day: dayBefore(today), at: slotOfDay(dayBefore(today), minutes, timeZone) };
  const last = inputs.lastNightlyAt === null ? null : Date.parse(inputs.lastNightlyAt);
  const covered = last !== null && (last >= reached.at || dayInZone(last, timeZone) === reached.day);
  if (!covered) return { due: true, slotAtMs: reached.at };
  return { due: false, nextAtMs: slotToday > nowMs ? slotToday : slotOfDay(dayAfter(today), minutes, timeZone) };
}
