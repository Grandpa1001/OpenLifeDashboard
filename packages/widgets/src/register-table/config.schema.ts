import { z } from "zod";

/** The page sizes the table may ask for (Scope §6.2); the server limits a page to the same range. */
export const PAGE_SIZE_RANGE = { min: 1, max: 100, default: 10 } as const;
/** The longest title of a register table. */
export const REGISTER_TABLE_TITLE_MAX = 80;

/**
 * The configuration of the register table, version 1. The registry, the columns and the sort column
 * are bindings, never a second copy here (Architektura §8.1).
 */
export const registerTableConfigSchema = z
  .object({
    v: z.literal(1),
    title: z.string().trim().max(REGISTER_TABLE_TITLE_MAX).default(""),
    pageSize: z.number().int().min(PAGE_SIZE_RANGE.min).max(PAGE_SIZE_RANGE.max).default(PAGE_SIZE_RANGE.default),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
    allowAdd: z.boolean().default(true),
  })
  .strict();
export type RegisterTableConfig = z.infer<typeof registerTableConfigSchema>;
