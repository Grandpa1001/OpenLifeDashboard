import { z } from "zod";

// Dictionaries over HTTP (Scope §5.8, Architektura §4.2, §5.2, §6; D24.2). The schemas check the
// shape of a request; what a symbol, a name or a label may be, and the limits, are the rules of
// core/dictionaries. A save carries the whole content and the revision the form was built on; a
// delete the revision the owner saw. The owner, the identifiers and the times are the server's.

export const DICTIONARIES_PATH = "/api/v1/dictionaries";
export const dictionaryPath = (symbol: string): string => `${DICTIONARIES_PATH}/${symbol}`;
/** One dictionary: read (`GET`), saved whole (`PUT`) and deleted (`DELETE`). */
export const DICTIONARY_PATH = `${DICTIONARIES_PATH}/:symbol` as const;

/** A request is bounded before the rules see it; the limits are the rules'. */
const REQUEST_TEXT_MAX = 400;
const REQUEST_VALUES_MAX = 5_000;
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const dictionaryValueRequestSchema = z
  .object({
    symbol: z.string().max(200),
    label: z.string().max(REQUEST_TEXT_MAX),
    hidden: z.boolean().optional(),
  })
  .strict();

export const createDictionaryRequestSchema = z
  .object({
    symbol: z.string().max(200),
    displayName: z.string().max(REQUEST_TEXT_MAX),
    values: z.array(dictionaryValueRequestSchema).max(REQUEST_VALUES_MAX).optional(),
  })
  .strict();
export type CreateDictionaryRequest = z.infer<typeof createDictionaryRequestSchema>;

/** The whole content in its order: a value left out is removed, a new symbol is added, the symbol of a value never changes. */
export const saveDictionaryRequestSchema = z
  .object({
    expectedRevision: revisionSchema,
    displayName: z.string().max(REQUEST_TEXT_MAX),
    values: z.array(dictionaryValueRequestSchema).max(REQUEST_VALUES_MAX),
  })
  .strict();
export type SaveDictionaryRequest = z.infer<typeof saveDictionaryRequestSchema>;

export const deleteDictionaryRequestSchema = z.object({ expectedRevision: revisionSchema }).strict();
export type DeleteDictionaryRequest = z.infer<typeof deleteDictionaryRequestSchema>;

export const dictionaryValueSchema = z.object({ symbol: z.string(), label: z.string(), hidden: z.boolean() }).strict();

/** A column of a registry that shows its values through the dictionary. */
export const dictionaryUsageSchema = z.object({ registrySymbol: z.string(), registryName: z.string(), columnSymbol: z.string(), columnName: z.string() }).strict();
export type DictionaryUsageDto = z.infer<typeof dictionaryUsageSchema>;

export const dictionarySchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    displayName: z.string(),
    revision: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** In their order. */
    values: z.array(dictionaryValueSchema),
    usages: z.array(dictionaryUsageSchema),
  })
  .strict();
export type DictionaryDto = z.infer<typeof dictionarySchema>;

export const dictionaryListSchema = z.object({ dictionaries: z.array(dictionarySchema) }).strict();
export type DictionaryListDto = z.infer<typeof dictionaryListSchema>;

/** The answer to a delete: the columns that were unpinned (they stay "choice", their values stay). */
export const dictionaryDeletedSchema = z.object({ unpinned: z.array(dictionaryUsageSchema) }).strict();
export type DictionaryDeletedDto = z.infer<typeof dictionaryDeletedSchema>;

/**
 * The labels of the values on one page, by column and symbol (Architektura §5.4): only for the
 * columns with a dictionary and the symbols it has, hidden ones too. A symbol without a label is
 * shown as it is.
 */
export const pageLabelsSchema = z.record(z.string(), z.record(z.string(), z.string()));
export type PageLabels = z.infer<typeof pageLabelsSchema>;
