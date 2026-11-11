// A date-time as the interface shows it with the default pattern of the owner (DD.MM.YYYY, D42.2), worked
// out here from the parts of the instant, not by the code of the interface.
export function shownDateTime(instant: string, timeZone: string, language = "en"): string {
  const at = new Date(instant);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const part = (type: string): string => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")}, ${new Intl.DateTimeFormat(language, { timeStyle: "short", timeZone }).format(at)}`;
}
