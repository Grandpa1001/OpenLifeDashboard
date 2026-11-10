import { z } from "zod";

// The application options over HTTP (Architektura §14.1, §14.3; D41.3). The options themselves, their
// types and ranges are the catalog of `contracts/settings`; here is the shape of a request and of the
// answer. A value is any JSON in a request on purpose: that it has the type and the range of its option
// is a rule with its own code (`SETTING_INVALID`), not a malformed request. The answer never carries a
// secret or the name of an environment variable: an option that the environment sets says only that.

export const SETTINGS_PATH = "/api/v1/settings";
export const settingPath = (key: string): string => `${SETTINGS_PATH}/${key}`;
/** One option: reset (`DELETE`). */
export const SETTING_PATH = `${SETTINGS_PATH}/:key` as const;

export const SETTING_SOURCES = ["default", "db", "env"] as const;
export const SETTING_TYPES = ["integer", "boolean", "enum", "time"] as const;

const valueSchema = z.union([z.number(), z.boolean(), z.string()]);

/** One option as the owner sees it: its value, where the value comes from, whether it can be changed, and what the catalog says of it. */
export const settingSchema = z
  .object({
    key: z.string(),
    type: z.enum(SETTING_TYPES),
    value: valueSchema,
    defaultValue: valueSchema,
    source: z.enum(SETTING_SOURCES),
    /** False when the option is read-only or the environment sets it. */
    editable: z.boolean(),
    /** True when a change takes effect only after a restart (or the environment sets the value). */
    restartRequired: z.boolean(),
    /** A change asks for a fresh second factor. */
    stepUp: z.boolean(),
    unit: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    values: z.array(z.string()).optional(),
    labelKey: z.string(),
  })
  .strict();
export type SettingDto = z.infer<typeof settingSchema>;

export const settingListSchema = z.object({ settings: z.array(settingSchema) }).strict();
export type SettingListDto = z.infer<typeof settingListSchema>;

/** The options to change, by key; all of them are changed or none. */
export const patchSettingsRequestSchema = z.object({ values: z.record(z.string().max(100), z.unknown()) }).strict();
export type PatchSettingsRequest = z.infer<typeof patchSettingsRequestSchema>;

/** A reset has nothing to say but the key in its path. */
export const resetSettingRequestSchema = z.object({}).strict();
