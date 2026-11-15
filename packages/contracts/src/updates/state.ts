// The durable record of an update (Architektura §11.2.1, §11.2.2; D52.2): what the updater writes to
// `control/update-state.json` and what the status of the update is rebuilt from, whatever happens to the browser,
// the app or the updater itself. One record is the whole state of the one operation that can run, or of none.
import { z } from "zod";
import { releaseVersionSchema } from "./protocol.js";

export const UPDATE_STATES = ["idle", "checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing", "completed", "rolling_back", "rolled_back", "recovery_failed"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

/** The states in which an operation holds the instance; the others leave it free (a closed operation or none). */
export const ACTIVE_UPDATE_STATES: readonly UpdateState[] = ["checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing", "rolling_back", "recovery_failed"];

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const updateRecordSchema = z
  .object({
    v: z.literal(1),
    /** Counts the records of the journal; a later one has a larger number, and recovery takes the largest that is whole. */
    seq: z.number().int().min(0),
    operationId: z.uuid().nullable(),
    state: z.enum(UPDATE_STATES),
    /** The largest fence of the maintenance gate the updater has accepted; a command with a smaller one is a crashed writer. */
    fence: z.number().int().min(0),
    targetRelease: releaseVersionSchema.nullable(),
    targetDigest: digestSchema.nullable(),
    previousDigest: digestSchema.nullable(),
    schemaVersionFrom: z.number().int().min(0).nullable(),
    schemaVersionTo: z.number().int().min(0).nullable(),
    backupId: z.string().regex(/^\d{8}T\d{6}Z-[a-z_]+-[0-9a-f-]{36}$/).nullable(),
    /** The pins of the release before the operation, so a rollback puts back exactly them. */
    previousSelection: z.object({ app: digestSchema.nullable(), updater: digestSchema.nullable() }).strict().nullable(),
    /** True from the commit point on; after it no rollback to the snapshot is made, as it would lose the data written since. */
    committed: z.boolean(),
    error: z.object({ code: z.string().min(1).max(64) }).strict().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type UpdateRecord = z.infer<typeof updateRecordSchema>;

/** The file: the record and the hash of its canonical text, so a torn or changed file is not mistaken for a record. */
export const updateFileSchema = z.object({ record: updateRecordSchema, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type UpdateFile = z.infer<typeof updateFileSchema>;

export const UPDATE_STATE_FILE = "update-state.json";
