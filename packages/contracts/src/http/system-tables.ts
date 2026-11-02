import { z } from "zod";

// The system preview over HTTP (Scope §3.1, §5.5; Architektura §6; D32.1): the tables the preview
// knows and one page of one of them, read only. The list of tables and their columns is core's
// (`SYSTEM_TABLES` of registries); the names are repeated here for the clients and a test keeps the
// two equal. A name outside the list is answered as a table that does not exist.

export const SYSTEM_TABLES_PATH = "/api/v1/system-tables";
export const SYSTEM_TABLE_PATH = `${SYSTEM_TABLES_PATH}/:name` as const;
export const systemTablePath = (name: string): string => `${SYSTEM_TABLES_PATH}/${encodeURIComponent(name)}`;

export const SYSTEM_TABLE_NAMES = ["registry", "registry_column", "screen", "widget", "binding", "audit_log"] as const;
export type SystemTableNameDto = (typeof SYSTEM_TABLE_NAMES)[number];

/** The rows of one page: 25 unless asked, never more than 100. */
export const SYSTEM_TABLE_PAGE_SIZE_DEFAULT = 25;
export const SYSTEM_TABLE_PAGE_SIZE_MAX = 100;
/** The last page a query may ask for: far beyond any table of one owner, and an offset SQLite takes as is. */
const SYSTEM_TABLE_PAGE_MAX = 1_000_000;

/** A number of a query string: digits only, so `1e3`, `-1`, `0x1` and spaces are refused by the shape. */
const queryInteger = z
  .string()
  .regex(/^\d{1,9}$/)
  .transform(Number);

/** A parameter the contract does not know is not read: an owner or a table in a query decides nothing. */
export const systemTableQuerySchema = z.object({
  page: queryInteger.pipe(z.number().int().min(1).max(SYSTEM_TABLE_PAGE_MAX)).optional(),
  pageSize: queryInteger.pipe(z.number().int().min(1).max(SYSTEM_TABLE_PAGE_SIZE_MAX)).optional(),
});
export type SystemTableQuery = z.infer<typeof systemTableQuerySchema>;

const systemValueSchema = z.union([z.string(), z.number(), z.null()]);

export const systemTableListSchema = z
  .object({
    tables: z.array(z.object({ name: z.enum(SYSTEM_TABLE_NAMES), columns: z.array(z.string()), rows: z.number().int().min(0) }).strict()),
  })
  .strict();
export type SystemTableListDto = z.infer<typeof systemTableListSchema>;

export const systemTablePageSchema = z
  .object({
    name: z.enum(SYSTEM_TABLE_NAMES),
    columns: z.array(z.string()),
    /** Each row is its values in the order of `columns`; JSON columns as their text. */
    rows: z.array(z.array(systemValueSchema)),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
  })
  .strict();
export type SystemTablePageDto = z.infer<typeof systemTablePageSchema>;
