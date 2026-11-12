// A size in bytes as the owner reads it: the largest unit that keeps the number above one, in the language of
// the page, with at most one decimal. Binary multiples (1024) under the names the platform's formatter knows.
const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
const STEP = 1024;

export function formatByteSize(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, { style: "unit", unit: UNITS[unit] ?? "byte", unitDisplay: "short", maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
}
