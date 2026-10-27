import { z } from "zod";

// The screen of the owner over HTTP (Architektura §4.2, §5.3–5.6, §6, §18.3, §18.5; D17): one
// snapshot holds the screen, its widgets, their configuration, bindings and layouts, and one PUT
// replaces it. A request carries what the owner designed; the state of a widget (draft, ok,
// needs_rebinding, needs_refresh) is the server's to work out and a client cannot send it.

export const SCREENS_PATH = "/api/v1/screens";
export const WIDGET_TYPES_PATH = "/api/v1/widget-types";

/** The most the server accepts of one screen; the rules of core/dashboard enforce the same numbers. */
export const DESIGN_LIMITS = {
  widgetsPerScreen: 50,
  bindingsPerWidget: 64,
  /** Bytes of the configuration of a widget, and of its bindings, as JSON (Architektura §8.1). */
  widgetJsonBytes: 32 * 1024,
  nameMaxChars: 80,
} as const;

/** The columns of the grid in each layout (Architektura §8.1). */
export const GRID_COLUMNS = { phone: 1, tablet: 8, desktop: 12 } as const;
export const LAYOUT_NAMES = ["phone", "tablet", "desktop"] as const;
export type LayoutName = (typeof LAYOUT_NAMES)[number];

/** The accents of the one theme (Załącznik H); the web app's tokens hold the colours. */
export const SCREEN_ACCENTS = ["blue", "green", "violet", "orange", "pink", "teal"] as const;
export const SCREEN_THEMES = ["dark"] as const;

export const WIDGET_STATES = ["draft", "ok", "needs_rebinding", "needs_refresh"] as const;
export type WidgetState = (typeof WIDGET_STATES)[number];

/** An identifier the server or a client made: a UUID version 7. */
export const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const SYSTEM_COLUMN_SYMBOLS = ["created_at", "updated_at", "id"] as const;
export const SYSTEM_VALUE_SYMBOLS = ["dzis", "wczoraj", "teraz", "strefa", "jezyk", "wersja"] as const;

/** What a binding points at, by permanent identifier (Architektura §5.6, §18.3). */
export const fieldRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("registry"), registryId: idSchema }).strict(),
  z.object({ kind: z.literal("column"), registryId: idSchema, columnId: idSchema }).strict(),
  z.object({ kind: z.literal("systemColumn"), registryId: idSchema, symbol: z.enum(SYSTEM_COLUMN_SYMBOLS) }).strict(),
  z.object({ kind: z.literal("config"), entryId: idSchema }).strict(),
  z.object({ kind: z.literal("system"), symbol: z.enum(SYSTEM_VALUE_SYMBOLS) }).strict(),
]);
export type FieldRefDto = z.infer<typeof fieldRefSchema>;

export const slotBindingSchema = z
  .object({
    slot: z.string().min(1).max(40),
    ordinal: z.number().int().min(0).max(DESIGN_LIMITS.bindingsPerWidget - 1),
    /** The readable name, `Field.Register.<registry>.<column>`; it must agree with the target, which is the identity. */
    path: z.string().min(1).max(300),
    target: fieldRefSchema,
  })
  .strict();
export type SlotBindingDto = z.infer<typeof slotBindingSchema>;

export const layoutRectSchema = z
  .object({
    x: z.number().int().min(0).max(999),
    y: z.number().int().min(0).max(9999),
    w: z.number().int().min(1).max(99),
    h: z.number().int().min(1).max(999),
  })
  .strict();
export type LayoutRectDto = z.infer<typeof layoutRectSchema>;

/** A layout for each breakpoint; `large` is reserved for a later version and absent until then. */
export const layoutSchema = z.object({ phone: layoutRectSchema, tablet: layoutRectSchema, desktop: layoutRectSchema }).strict();
export type LayoutDto = z.infer<typeof layoutSchema>;

/** Bytes of the JSON of a value in UTF-8, counted by code point (contracts use no platform API). */
function jsonBytes(value: unknown): number {
  let bytes = 0;
  for (const char of JSON.stringify(value)) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The configuration of a widget: a version and what its type defines; the type's schema decides the rest. */
export const widgetConfigSchema = z
  .object({ v: z.number().int().min(1).max(1000) })
  .catchall(z.json())
  .refine((config) => jsonBytes(config) <= DESIGN_LIMITS.widgetJsonBytes, { message: "config_too_large" });

export const widgetDesignSchema = z
  .object({
    id: idSchema,
    type: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    config: widgetConfigSchema,
    layout: layoutSchema,
    bindings: z
      .array(slotBindingSchema)
      .max(DESIGN_LIMITS.bindingsPerWidget)
      .refine((bindings) => jsonBytes(bindings) <= DESIGN_LIMITS.widgetJsonBytes, { message: "bindings_too_large" }),
  })
  .strict();
export type WidgetDesignDto = z.infer<typeof widgetDesignSchema>;

/** What the owner designs: sent whole by the Designer, replaced atomically by the server. */
export const designSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(DESIGN_LIMITS.nameMaxChars),
    theme: z.enum(SCREEN_THEMES),
    accent: z.enum(SCREEN_ACCENTS),
    widgets: z.array(widgetDesignSchema).max(DESIGN_LIMITS.widgetsPerScreen),
  })
  .strict();
export type DesignSnapshotDto = z.infer<typeof designSnapshotSchema>;
