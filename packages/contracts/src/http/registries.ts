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

// The preview of a change of the structure (Scope §5.6, Architektura §4.6, §5.2; D26.2). One request
// is one change; a column is named by its permanent identifier. The rules of a change (what a type
// may change to, what a new column may be) are core/registries'; here only the shape is checked. The
// preview writes nothing: it answers with what the change would do and, unless it is blocked, a plan
// that lasts a short time and is bound to this change and the registry as it is now.

export const REGISTRY_STRUCTURE_PREVIEW_PATH = `${REGISTRIES_PATH}/:symbol/structure/preview` as const;
export const structurePreviewPath = (symbol: string): string => `${REGISTRIES_PATH}/${symbol}/structure/preview`;

const columnIdSchema = z.string().max(64);
const typeOptionsRequestSchema = z.record(z.string().max(100), z.unknown());

export const structureChangeRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("addColumn"), column: newColumnRequestSchema }).strict(),
  z.object({ kind: z.literal("renameColumn"), columnId: columnIdSchema, displayName: z.string().max(400) }).strict(),
  z.object({ kind: z.literal("removeColumn"), columnId: columnIdSchema }).strict(),
  z.object({ kind: z.literal("changeType"), columnId: columnIdSchema, type: z.string().max(40), typeOptions: typeOptionsRequestSchema.optional(), required: z.boolean().optional(), replacement: cellValueSchema.optional() }).strict(),
  z.object({ kind: z.literal("setRequired"), columnId: columnIdSchema, required: z.boolean(), replacement: cellValueSchema.optional() }).strict(),
  z.object({ kind: z.literal("deleteRegistry") }).strict(),
]);
export type StructureChangeRequest = z.infer<typeof structureChangeRequestSchema>;

export const structurePreviewRequestSchema = z.object({ change: structureChangeRequestSchema }).strict();
export type StructurePreviewRequest = z.infer<typeof structurePreviewRequestSchema>;

export const STRUCTURE_BLOCKS = ["REQUIRED_VALUES_LOST", "REQUIRED_EMPTY"] as const;

const countSchema = z.number().int().min(0);

export const structurePreviewSchema = z
  .object({
    registry: z.object({ symbol: z.string(), schemaRevision: z.number().int().min(1), dataRevision: z.number().int().min(0) }).strict(),
    records: countSchema,
    affected: countSchema,
    widgets: z.array(z.object({ screen: z.object({ id: z.string(), name: z.string() }).strict(), widgetId: z.string(), title: z.string().nullable(), slots: z.array(z.string()) }).strict()),
    /** For a change of a column's type: the values that would change, stay, are empty or would not convert, with the most frequent failures. */
    conversion: z
      .object({ converted: countSchema, unchanged: countSchema, empty: countSchema, failed: countSchema, samples: z.array(z.object({ value: cellValueSchema, count: z.number().int().min(1) }).strict()) })
      .strict()
      .optional(),
    blocked: z.enum(STRUCTURE_BLOCKS).nullable(),
    planToken: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type StructurePreviewDto = z.infer<typeof structurePreviewSchema>;
