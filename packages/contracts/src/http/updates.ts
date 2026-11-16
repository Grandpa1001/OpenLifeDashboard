import { z } from "zod";

// The releases over HTTP (Architektura §11.1; D53.3). Two routes for the owner whose session passes the gate of the
// private data: the state of the check (the running version, the newest stable release and whether it is newer, when it
// was asked, when it will be asked again, what the last failure was) and "Check now". Neither takes an address, a
// repository or a version: the source of the releases is the installation's, never the request's.

export const UPDATES_PATH = "/api/v1/updates";
export const UPDATES_CHECK_PATH = "/api/v1/updates/check";

const releaseSchema = z
  .object({
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    publishedAt: z.iso.datetime(),
    notes: z.string().max(20_000),
    url: z.string().max(300).startsWith("https://github.com/"),
  })
  .strict();

export const updatesStatusSchema = z
  .object({
    /** False when the installation has no updater and no source of releases: there is nothing to check and nothing to ask. */
    configured: z.boolean(),
    /** The option `updates.checkEnabled`: the daily check. "Check now" works whatever it says. */
    enabled: z.boolean(),
    /** The version of the running application. */
    current: z.string().min(1).max(64),
    available: z.boolean(),
    /** The newest stable release known (also when it is not newer), or null before the first answer. */
    latest: releaseSchema.nullable(),
    /** When the source last answered, or null. */
    checkedAt: z.iso.datetime().nullable(),
    /** When the daily check is next made, or null when it is off or not configured. */
    nextCheckAt: z.iso.datetime().nullable(),
    /** The code of the last failure of the check, or null. */
    error: z.object({ code: z.string().min(1).max(64) }).strict().nullable(),
    /** Nothing is asked before this time (a backoff or a limit of the source), or null. */
    retryAt: z.iso.datetime().nullable(),
  })
  .strict();
export type UpdatesStatusDto = z.infer<typeof updatesStatusSchema>;

/** "Check now" takes nothing: there is no address to give. */
export const updatesCheckBodySchema = z.object({}).strict();

export const updatesCheckResultSchema = updatesStatusSchema.extend({ outcome: z.enum(["updated", "unchanged", "failed"]) }).strict();
export type UpdatesCheckResultDto = z.infer<typeof updatesCheckResultSchema>;
