import { z } from "zod";

// Registries over HTTP (Architektura §5.1, §6; D14.3). The schemas check the shape of a request;
// the rules of the catalog (symbols, types, options, defaults, limits) are core/registries'. A
// request carries a definition only: the owner, the identifiers, the revisions and the timestamps
// are the server's, and a field the contract does not know is refused.

export const REGISTRIES_PATH = "/api/v1/registries";

export const COLUMN_TYPE_CODES = ["text", "number", "money", "date", "datetime", "time", "boolean", "choice"] as const;

/** A request is bounded before the rules see it; the limits of the catalog are the rules'. */
const REQUEST_STRING_MAX = 10_100;
const REQUEST_COLUMNS_MAX = 200;

const cellValueSchema = z.union([z.string().max(REQUEST_STRING_MAX), z.number(), z.boolean(), z.null()]);

export const newColumnRequestSchema = z
  .object({
    symbol: z.string().max(200),
    displayName: z.string().max(400),
    type: z.string().max(40),
    typeOptions: z.record(z.string().max(100), z.unknown()).optional(),
    defaultValue: cellValueSchema.optional(),
    required: z.boolean().optional(),
  })
  .strict();

export const createRegistryRequestSchema = z
  .object({
    symbol: z.string().max(200),
    displayName: z.string().max(400),
    columns: z.array(newColumnRequestSchema).max(REQUEST_COLUMNS_MAX),
  })
  .strict();
export type CreateRegistryRequest = z.infer<typeof createRegistryRequestSchema>;

export const registryColumnSchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    displayName: z.string(),
    type: z.enum(COLUMN_TYPE_CODES),
    typeOptions: z.object({ decimalPlaces: z.number().int().optional(), dictionaryId: z.string().optional() }).strict(),
    defaultValue: cellValueSchema,
    required: z.boolean(),
    position: z.number().int().min(0),
  })
  .strict();

export const registrySchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    displayName: z.string(),
    schemaRevision: z.number().int().min(1),
    dataRevision: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    columns: z.array(registryColumnSchema),
  })
  .strict();
export type RegistryDto = z.infer<typeof registrySchema>;

export const registryListSchema = z.object({ registries: z.array(registrySchema) }).strict();
export type RegistryListDto = z.infer<typeof registryListSchema>;

/** The issues a rejected definition lists in `details.issues`: where, and why as a stable code. */
export const registryIssueSchema = z.object({ path: z.string(), code: z.string() }).strict();
export const registryRejectionDetailsSchema = z.object({ issues: z.array(registryIssueSchema) }).strict();
