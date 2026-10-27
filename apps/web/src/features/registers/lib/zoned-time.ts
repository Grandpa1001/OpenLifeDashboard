// Wall-clock time in an IANA zone and the UTC instant it stands for. The API carries date-times as
// ISO 8601 UTC; the owner reads and types them in their own zone (Scope §6.2), and the browser's
// zone is not necessarily theirs, so the zone is applied here and not by `datetime-local`.
type Part = "year" | "month" | "day" | "hour" | "minute" | "second";

function wallClock(instantMs: number, timeZone: string): Record<Part, number> {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instantMs));
  const read = (type: Part): number => Number(formatted.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

/** The zone's offset from UTC at an instant, in milliseconds (east is positive). */
function offsetMs(instantMs: number, timeZone: string): number {
  const wall = wallClock(instantMs, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instantMs / 1000) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * `YYYY-MM-DDTHH:mm` on the wall of `timeZone` as an ISO UTC instant, or null when the text is not a
 * moment that exists on a calendar. In the hour a clock change repeats, the earlier instant is taken;
 * in the hour it skips, the instant is the one the clock would have shown after the change.
 */
export function zonedLocalToUtcIso(local: string, timeZone: string): string | null {
  const match = LOCAL.exec(local);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  // The zone's offset a day before and a day after bounds every change of the clock around this wall time.
  const offsets = new Set([offsetMs(asUtc - DAY_MS, timeZone), offsetMs(asUtc + DAY_MS, timeZone)]);
  const instants = [...offsets].map((offset) => asUtc - offset).filter((instant) => offsetMs(instant, timeZone) === asUtc - instant);
  // Two instants share the wall in the hour a change repeats (the first is taken); none in the hour it skips.
  const instant = instants.length > 0 ? Math.min(...instants) : asUtc - offsetMs(asUtc - DAY_MS, timeZone);
  return new Date(instant).toISOString();
}

/** An ISO UTC instant as `YYYY-MM-DDTHH:mm` on the wall of `timeZone`. */
export function utcIsoToZonedLocal(iso: string, timeZone: string): string | null {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return null;
  const wall = wallClock(instant, timeZone);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${String(wall.year).padStart(4, "0")}-${two(wall.month)}-${two(wall.day)}T${two(wall.hour)}:${two(wall.minute)}`;
}
