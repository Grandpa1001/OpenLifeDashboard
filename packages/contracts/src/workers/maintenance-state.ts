import { z } from "zod";

// control/maintenance/state.json v1 (Architektura §4.8, §11.4): the durable maintenance gate,
// kept outside the database it protects. It is separate from the writer lease: recovering the
// lease after a crash never clears an operation recorded here. The union of operations is
// closed; an unknown variant is refused, not ignored. D04.3/D05 refine phases of their own
// operations here, without a second gate format.

export const MAINTENANCE_STATE_FORMAT_VERSION = 1;

const operationFields = {
  operationId: z.uuid(),
  startedAt: z.iso.datetime(),
};

const schemaVersion = z.int().min(0);

/** Creating the first schema of a new, empty database (D04.3). */
const initOperationSchema = z
  .object({ ...operationFields, reason: z.literal("init"), phase: z.enum(["initializing"]), targetSchemaVersion: schemaVersion })
  .strict();

/** Upgrading an existing database; the pre_migration snapshot is a phase of it (D05.2). */
const migrateOperationSchema = z
  .object({
    ...operationFields,
    reason: z.literal("migrate"),
    phase: z.enum(["snapshot", "migrating", "verifying"]),
    fromSchemaVersion: schemaVersion,
    toSchemaVersion: schemaVersion,
    snapshotId: z.string().min(1).nullable(),
  })
  .strict();

/** A standalone database snapshot; it is visible as completed only after publication (D05.3). */
const snapshotOperationSchema = z
  .object({ ...operationFields, reason: z.literal("snapshot"), phase: z.enum(["staging", "publishing"]), snapshotId: z.string().min(1) })
  .strict();

export const maintenanceOperationSchema = z.discriminatedUnion("reason", [
  initOperationSchema,
  migrateOperationSchema,
  snapshotOperationSchema,
]);

export const maintenanceStateSchema = z
  .object({
    formatVersion: z.literal(MAINTENANCE_STATE_FORMAT_VERSION),
    /** Monotonic fence: every new operation persists the next generation before it mutates data. */
    generation: z.int().min(0),
    activeOperation: maintenanceOperationSchema.nullable(),
  })
  .strict();

export type MaintenanceOperation = z.infer<typeof maintenanceOperationSchema>;
export type MaintenanceState = z.infer<typeof maintenanceStateSchema>;
