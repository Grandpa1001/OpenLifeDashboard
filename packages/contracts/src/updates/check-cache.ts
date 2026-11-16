// The cache of the check of the releases (Architektura §11.1; D53.2): what the application remembers between two
// checks, so that a restart asks with the ETag it had and shows the release it knew while the network is away. It is a
// file that can be lost without harm (the next check makes it again), so it is not in the database and not in the
// backups, and a file that does not read as this is the same as none.
import { z } from "zod";

export const UPDATE_CHECK_CACHE_FILE = "update-check.json";
/** The file holds at most this many bytes of text; a larger one is not read. */
export const UPDATE_CHECK_CACHE_MAX_BYTES = 4 * 1024 * 1024;

const releaseSchema = z
  .object({
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    tag: z.string().min(1).max(64),
    publishedAt: z.iso.datetime(),
    notes: z.string().max(20_000),
    url: z.string().max(300).startsWith("https://github.com/"),
  })
  .strict();

export const updateCheckCacheSchema = z
  .object({
    v: z.literal(1),
    /** The repository the cache is of; a cache of another repository is none. */
    repository: z.string().min(3).max(140),
    etag: z.string().min(1).max(200).nullable(),
    releases: z.array(releaseSchema).max(100),
    state: z
      .object({
        failures: z.number().int().min(0),
        lastAttemptAtMs: z.number().int().min(0).nullable(),
        lastSuccessAtMs: z.number().int().min(0).nullable(),
        notBeforeMs: z.number().int().min(0).nullable(),
        rateLimited: z.boolean(),
      })
      .strict(),
    /** The code of the last failure, or null after a success. */
    lastErrorCode: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type UpdateCheckCache = z.infer<typeof updateCheckCacheSchema>;
