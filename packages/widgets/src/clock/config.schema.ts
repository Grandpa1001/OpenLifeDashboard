import { z } from "zod";

/** The zone a clock shows when it has none of its own: the zone of the owner, followed when the owner changes it (Scope §6.3). */
export const OWNER_ZONE = "owner";
/** The longest caption of a clock (e.g. "Dom"). */
export const CLOCK_LABEL_MAX = 40;

/** A zone the runtime knows by its IANA name; `Intl` is the one authority, the same in the server and the browser. */
export function isKnownTimeZone(name: string): boolean {
  if (name === "" || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The configuration of the clock, version 1 (Scope §6.3; D36.1), as F01 writes it. It has no bindings. */
export const clockConfigSchema = z
  .object({
    v: z.literal(1),
    timezone: z.string().refine((zone) => zone === OWNER_ZONE || isKnownTimeZone(zone), { message: "timezone_unknown" }).default(OWNER_ZONE),
    label: z.string().trim().max(CLOCK_LABEL_MAX).default(""),
    format: z.enum(["24h", "12h"]).default("24h"),
    showSeconds: z.boolean().default(false),
    showDate: z.boolean().default(true),
  })
  .strict();
export type ClockConfig = z.infer<typeof clockConfigSchema>;
