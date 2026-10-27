import { z } from "zod";
import { REGISTRIES_PATH } from "./registries.js";

// The records of a registry over HTTP (Architektura §5.4, §6; D15.3). A request carries values
// and the revision of the schema the form was built on; the identifier, the owner, the times and
// the revision of the record are the server's, and a field the contract does not know is refused.
// What a value may be is core/registries' rule; here only the shape is checked.

export const registryRecordsPath = (symbol: string): string => `${REGISTRIES_PATH}/${symbol}/records`;
/** The route as the server registers it. */
export const REGISTRY_RECORDS_PATH = `${REGISTRIES_PATH}/:symbol/records` as const;

/** The header that makes a repeated add one add (Architektura §4.6). */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

const REQUEST_STRING_MAX = 10_100;
const cellValueSchema = z.union([z.string().max(REQUEST_STRING_MAX), z.number(), z.boolean(), z.null()]);

export const createRecordRequestSchema = z
  .object({
    schemaRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    /** The shape is checked by the rules of the registry, which name every field that is wrong. */
    values: z.record(z.string().max(200), z.unknown()),
  })
  .strict();
export type CreateRecordRequest = z.infer<typeof createRecordRequestSchema>;

export const recordSchema = z
  .object({
    id: z.string(),
    revision: z.number().int().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    values: z.record(z.string(), cellValueSchema),
  })
  .strict();
export type RecordDto = z.infer<typeof recordSchema>;

/** A number of a query string: digits only, so `1e3`, `-1`, `0x1` and spaces are refused by the shape. */
const queryInteger = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(Number);

/** A parameter the contract does not know is not read: an owner or a registry in a query decides nothing. */
export const listRecordsQuerySchema = z
  .object({
    sort: z.string().max(100).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    page: queryInteger.optional(),
    pageSize: queryInteger.optional(),
  });
export type ListRecordsQuery = z.infer<typeof listRecordsQuerySchema>;

export const recordPageSchema = z
  .object({
    records: z.array(recordSchema),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    /** The revisions a form built from this page sends back (`schemaRevision`). */
    schemaRevision: z.number().int().min(1),
    dataRevision: z.number().int().min(0),
  })
  .strict();
export type RecordPageDto = z.infer<typeof recordPageSchema>;
