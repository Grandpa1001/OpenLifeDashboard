import { z } from "zod";
import { UPDATE_STATES } from "../updates/state.js";

// The releases over HTTP (Architektura §11.1; D53.3). Two routes for the owner whose session passes the gate of the
// private data: the state of the check (the running version, the newest stable release and whether it is newer, when it
// was asked, when it will be asked again, what the last failure was) and "Check now". Neither takes an address, a
// repository or a version: the source of the releases is the installation's, never the request's.

export const UPDATES_PATH = "/api/v1/updates";
export const UPDATES_CHECK_PATH = "/api/v1/updates/check";
export const UPDATES_INSTALL_PATH = "/api/v1/updates/install";

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
    /** The operation of the update as the journal of the updater has it (never from the request), or null when there is none or the updater cannot be asked. */
    operation: z
      .object({ operationId: z.uuid(), state: z.enum(UPDATE_STATES), targetRelease: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/).nullable(), error: z.object({ code: z.string().min(1).max(64) }).strict().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type UpdatesStatusDto = z.infer<typeof updatesStatusSchema>;

/** "Check now" takes nothing: there is no address to give. */
export const updatesCheckBodySchema = z.object({}).strict();

export const updatesCheckResultSchema = updatesStatusSchema.extend({ outcome: z.enum(["updated", "unchanged", "failed"]) }).strict();
export type UpdatesCheckResultDto = z.infer<typeof updatesCheckResultSchema>;

/**
 * Starts the update to the release the last check found (D54.4). Only a version, never an image or an address; the owner
 * proves a fresh second factor, and the same `operationId` asked again is the same operation.
 */
export const updatesInstallBodySchema = z
  .object({ release: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/), operationId: z.uuid().optional() })
  .strict();
export const updatesInstallResultSchema = z.object({ operationId: z.uuid(), release: z.string(), accepted: z.literal(true) }).strict();
export type UpdatesInstallResultDto = z.infer<typeof updatesInstallResultSchema>;
