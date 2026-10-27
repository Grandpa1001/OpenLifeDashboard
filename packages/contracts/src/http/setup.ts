import { z } from "zod";
import { SUPPORTED_LOCALES } from "../locales.js";
import { NEXT_ACTIONS } from "./identity.js";

// First setup after the gate (Architektura §9.7, §18.7; D11.4): the stage, the choice of the
// starting data and the owner's preferences. Every operation needs the session and the state the
// access policy asks for; the DTOs carry nothing of the authentication.

export const SETUP_STATUS_PATH = "/api/v1/setup/status";
export const SETUP_CHOOSE_EMPTY_PATH = "/api/v1/setup/choose-empty";
export const SETUP_PREFERENCES_PATH = "/api/v1/setup/preferences";

export const DATA_CHOICES = ["unselected", "empty", "imported"] as const;
/** Where the setup stands: the starting data, then the preferences, then done (the guide is D18). */
export const SETUP_STAGES = ["data", "preferences", "complete"] as const;

/** An IANA time zone name as the runtime knows it. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((name) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: name });
      return true;
    } catch {
      return false;
    }
  }, { message: "unknown_time_zone" });

export const ownerPreferencesSchema = z.object({ timezone: timeZoneSchema, locale: z.enum(SUPPORTED_LOCALES) }).strict();
export type OwnerPreferencesDto = z.infer<typeof ownerPreferencesSchema>;

export const setupStatusSchema = z
  .object({
    stage: z.enum(SETUP_STAGES),
    dataChoice: z.enum(DATA_CHOICES),
    nextAction: z.enum(NEXT_ACTIONS),
  })
  .strict();
export type SetupStatusDto = z.infer<typeof setupStatusSchema>;

export const chooseEmptyRequestSchema = z.object({}).strict();
export const chooseEmptyResponseSchema = z.object({ dataChoice: z.literal("empty"), stage: z.enum(SETUP_STAGES) }).strict();

/** `preferences` is null until the owner has saved them. */
export const preferencesResponseSchema = z.object({ preferences: ownerPreferencesSchema.nullable(), stage: z.enum(SETUP_STAGES) }).strict();
