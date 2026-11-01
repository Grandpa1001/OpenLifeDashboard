// Calendar days in a time zone (Architektura §4.5 p. 9): a date is a day of the owner's calendar,
// so a date-time becomes the day it falls on in the owner's zone, and a day begins at the owner's
// midnight, whatever the zone of the server. Pure: the zone is passed in; Intl knows its rules.

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The wall clock of an instant in a zone, field by field. */
function wallOf(instantMs: number, timeZone: string): Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number }> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instantMs);
  const part = (type: string): number => Number(parts.find((each) => each.type === type)?.value ?? "0");
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

/** The calendar day `YYYY-MM-DD` of an instant in a zone. */
export function dayInZone(instantMs: number, timeZone: string): string {
  const wall = wallOf(instantMs, timeZone);
  return `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** How far the wall clock of a zone is ahead of UTC at an instant, in milliseconds. */
function offsetMs(instantMs: number, timeZone: string): number {
  const wall = wallOf(instantMs, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The first instant of a calendar day in a zone: its midnight, or — where the clock jumps over
 * midnight — the first moment the day has. Null for a text that is no calendar day.
 */
export function startOfDayInZone(day: string, timeZone: string): number | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = match.slice(1, 4).map(Number) as [number, number, number];
  const midnight = Date.UTC(year, month - 1, date);
  if (new Date(midnight).toISOString().slice(0, 10) !== day) return null;
  // The offset a little before and a little after midnight: the earlier instant that still falls on the day wins.
  for (const guess of [midnight - offsetMs(midnight - 86_400_000 / 2, timeZone), midnight - offsetMs(midnight + 86_400_000 / 2, timeZone)].sort((a, b) => a - b)) {
    if (dayInZone(guess, timeZone) === day) return guess;
  }
  // No midnight on this day (the clock jumped over it): the first whole hour of the day.
  for (let hour = 1; hour <= 3; hour += 1) {
    const guess = midnight + hour * 3_600_000 - offsetMs(midnight + hour * 3_600_000, timeZone);
    if (dayInZone(guess, timeZone) === day) return guess;
  }
  return null;
}

/** The day before a calendar day, counted on the calendar (a day of 23 or 25 hours is still one day). */
export function dayBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}
