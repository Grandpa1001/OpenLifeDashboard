import { z } from "zod";

// ConfigTable over HTTP (Scope §5.7, Architektura §4.2, §5.3, §6, §9.5; D25.2). The schemas check
// the shape of a request; what a symbol, a name, a value or a description may be, and the limits,
// are the rules of core/configuration. A value is any JSON here on purpose: that it must be text is
// a rule with its own code (`VALUE_NOT_TEXT`), not a malformed request. A save carries the whole
// entry and the revision the form was built on; a delete the revision the owner saw.

export const CONFIG_PATH = "/api/v1/config";
export const configEntryPath = (symbol: string): string => `${CONFIG_PATH}/${symbol}`;
/** One entry: read (`GET`), saved whole (`PUT`) and deleted (`DELETE`). */
export const CONFIG_ENTRY_PATH = `${CONFIG_PATH}/:symbol` as const;

/** The readable path a widget binds an entry by. */
export const configFieldPath = (symbol: string): string => `Field.Config.${symbol}`;

/** A request is bounded before the rules see it: above the top of `limits.textLength`, so the rules give the code. */
const REQUEST_VALUE_MAX = 400_000;
const REQUEST_TEXT_MAX = 4_000;
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const valueSchema = z.unknown().refine((value) => typeof value !== "string" || value.length <= REQUEST_VALUE_MAX);

export const createConfigEntryRequestSchema = z
  .object({
    symbol: z.string().max(200),
    displayName: z.string().max(REQUEST_TEXT_MAX),
    value: valueSchema,
    description: z.unknown().optional(),
  })
  .strict();
export type CreateConfigEntryRequest = z.infer<typeof createConfigEntryRequestSchema>;

/** The whole entry but its symbol, on the revision it was loaded with. */
export const saveConfigEntryRequestSchema = z
  .object({
    expectedRevision: revisionSchema,
    displayName: z.string().max(REQUEST_TEXT_MAX),
    value: valueSchema,
    description: z.unknown().optional(),
  })
  .strict();
export type SaveConfigEntryRequest = z.infer<typeof saveConfigEntryRequestSchema>;

export const deleteConfigEntryRequestSchema = z.object({ expectedRevision: revisionSchema }).strict();
export type DeleteConfigEntryRequest = z.infer<typeof deleteConfigEntryRequestSchema>;

export const configEntrySchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    displayName: z.string(),
    /** Always text, as it was saved. */
    value: z.string(),
    description: z.string(),
    revision: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** The bindings of the owner's widgets that point at the entry. */
    bindings: z.number().int().min(0),
  })
  .strict();
export type ConfigEntryDto = z.infer<typeof configEntrySchema>;

export const configEntryListSchema = z.object({ entries: z.array(configEntrySchema) }).strict();
export type ConfigEntryListDto = z.infer<typeof configEntryListSchema>;

/** The answer to a delete: how many bindings point at nothing now. */
export const configEntryDeletedSchema = z.object({ bindings: z.number().int().min(0) }).strict();
export type ConfigEntryDeletedDto = z.infer<typeof configEntryDeletedSchema>;
