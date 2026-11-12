import { z } from "zod";
import { registryColumnSchema } from "../http/registries.js";
import { idSchema, SCREEN_ACCENTS, SCREEN_THEMES, widgetDesignSchema } from "../http/screens.js";
import { ownerPreferencesSchema } from "../http/setup.js";

// The format of the export and import (Architektura Załącznik G; D45): one JSON file, readable and not
// encrypted, that holds the owner's settings, the entries of ConfigTable, the dictionaries, the registries
// with their structure and records, and the screens. It holds no authentication data, no audit log, no catalog
// of copies, no application flags and no `user_id`. These schemas give the SHAPE of a file; the rules of the
// catalogs (symbols, names, types, limits, values) are those of the modules, applied by the parser of the
// server. The format has its own version, separate from the version of the application and from the `v` of
// the configuration of a widget; a change that is not compatible raises it and adds a migration to the chain.

export const EXPORT_FORMAT = "openlifedashboard-export";
export const EXPORT_FORMAT_VERSION = 1;

/** The name of the file the owner downloads: the day of the export, in UTC. */
export function exportFileName(exportedAt: Date): string {
  return `openlifedashboard-${exportedAt.toISOString().slice(0, 10)}.json`;
}

const instant = z.iso.datetime();
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const exportConfigEntrySchema = z
  .object({ id: idSchema, symbol: z.string(), displayName: z.string(), value: z.string(), description: z.string() })
  .strict();

export const exportDictionaryValueSchema = z
  .object({ id: idSchema, symbol: z.string(), label: z.string(), position: z.number().int().min(0), hidden: z.boolean() })
  .strict();

export const exportDictionarySchema = z
  .object({ id: idSchema, symbol: z.string(), displayName: z.string(), values: z.array(exportDictionaryValueSchema) })
  .strict();

/** A record: its identifier and revision are kept, the values are by the symbols of the columns, an empty one is `null`. */
export const exportRecordSchema = z
  .object({ id: idSchema, revision: z.number().int().min(1), createdAt: instant, updatedAt: instant, values: z.record(z.string(), cell) })
  .strict();

export const exportRegistrySchema = z
  .object({
    id: idSchema,
    symbol: z.string(),
    displayName: z.string(),
    schemaRevision: z.number().int().min(1),
    dataRevision: z.number().int().min(0),
    columns: z.array(registryColumnSchema),
    records: z.array(exportRecordSchema),
  })
  .strict();

export const exportScreenSchema = z
  .object({ id: idSchema, name: z.string(), theme: z.enum(SCREEN_THEMES), accent: z.enum(SCREEN_ACCENTS), widgets: z.array(widgetDesignSchema) })
  .strict();

export const exportFileSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    formatVersion: z.literal(EXPORT_FORMAT_VERSION),
    appVersion: z.string().min(1).max(64),
    exportedAt: instant,
    settings: ownerPreferencesSchema,
    configEntries: z.array(exportConfigEntrySchema),
    dictionaries: z.array(exportDictionarySchema),
    registries: z.array(exportRegistrySchema),
    screens: z.array(exportScreenSchema),
  })
  .strict();
export type ExportFile = z.infer<typeof exportFileSchema>;
export type ExportRegistry = z.infer<typeof exportRegistrySchema>;
export type ExportRecord = z.infer<typeof exportRecordSchema>;
