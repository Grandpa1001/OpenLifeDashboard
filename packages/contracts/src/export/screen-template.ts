import { z } from "zod";
import { DESIGN_LIMITS, layoutSchema, SCREEN_ACCENTS, SCREEN_THEMES, widgetConfigSchema } from "../http/screens.js";

// The format of the template of a screen (Architektura Załącznik G; D47): one JSON file with the design of
// one screen, to move it to another installation. It holds no data of any registry, no identifier of the screen,
// of a widget or of a target, and no `user_id`: a binding is its slot, its place in the slot and the readable
// path `Field.*`, which the installation that imports it resolves against its own catalog. The format has its
// own version, separate from the export of the whole data and from the version of the application.

export const SCREEN_TEMPLATE_FORMAT = "openlifedashboard-screen-template";
export const SCREEN_TEMPLATE_FORMAT_VERSION = 1;

/** The name of the file the owner downloads: the day of the export, in UTC. */
export function screenTemplateFileName(exportedAt: Date): string {
  return `openlifedashboard-screen-${exportedAt.toISOString().slice(0, 10)}.json`;
}

export const templateBindingSchema = z
  .object({
    slot: z.string().min(1).max(40),
    ordinal: z.number().int().min(0).max(DESIGN_LIMITS.bindingsPerWidget - 1),
    path: z.string().min(1).max(300),
  })
  .strict();

export const templateWidgetSchema = z
  .object({
    type: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    config: widgetConfigSchema,
    layout: layoutSchema,
    bindings: z.array(templateBindingSchema).max(DESIGN_LIMITS.bindingsPerWidget),
  })
  .strict();

export const screenTemplateSchema = z
  .object({
    format: z.literal(SCREEN_TEMPLATE_FORMAT),
    formatVersion: z.literal(SCREEN_TEMPLATE_FORMAT_VERSION),
    appVersion: z.string().min(1).max(64),
    exportedAt: z.iso.datetime(),
    screen: z
      .object({
        name: z.string().trim().min(1).max(DESIGN_LIMITS.nameMaxChars),
        theme: z.enum(SCREEN_THEMES),
        accent: z.enum(SCREEN_ACCENTS),
        widgets: z.array(templateWidgetSchema).max(DESIGN_LIMITS.widgetsPerScreen),
      })
      .strict(),
  })
  .strict();
export type ScreenTemplate = z.infer<typeof screenTemplateSchema>;
