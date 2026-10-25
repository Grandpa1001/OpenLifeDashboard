// Opening the installation database under the writer lease (Architektura §4.8; D04.3). The
// file is inspected before the writer opens it. An empty database is initialized as an `init`
// operation of the maintenance gate; an `init` interrupted by a crash is reconciled from the
// database itself (empty → initialize again, complete → close the operation). Any other active
// operation, a foreign or newer database, a changed migration or another instance's database
// refuses the start. An interrupted `migrate` is reconciled from the database file: still at the
// old version → the same operation continues (a published snapshot of it is recognized and
// verified again, otherwise a new one is taken); already at the new version → it only closes. Upgrading an existing database (D05.2) is one `migrate` operation under the
// writer lease: verified pre_migration snapshot of the old version → all pending migrations in
// one transaction → check → close the operation. No snapshot, no migration; a failing migration
// rolls back as a whole and leaves the database at its version and the snapshot published.
import type { DatabaseSnapshotPort } from "@openlife/core/maintenance";
import { ConnectionSettingError, openDatabase, type SqliteConnection } from "@openlife/sqlite/connection";
import {
  DATABASE_FIELD,
  initializeDatabase,
  inspectDatabase,
  MigrationFailedError,
  migrateDatabase,
  MigrationPlanError,
  targetSchemaVersion,
  validatePlan,
  type DatabaseRefusalCode,
  type MigrationPlan,
} from "@openlife/sqlite/migrations";
import type { MaintenanceOperation } from "@openlife/contracts/workers/maintenance-state";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";

export type DatabaseOpenCode =
  | DatabaseRefusalCode
  | "MAINTENANCE_RECOVERY_REQUIRED"
  | "MIGRATION_SNAPSHOT_REQUIRED"
  | "MIGRATION_FAILED"
  | "DATABASE_MISSING"
  | "DATABASE_UNAVAILABLE";

export type DatabaseOpenResult =
  | Readonly<{ ok: true; connection: SqliteConnection; schemaVersion: number; created: boolean }>
  | Readonly<{ ok: false; code: DatabaseOpenCode; fields: readonly string[] }>;

export type DatabaseOpenInputs = Readonly<{
  file: string;
  /** The gate opened under the lease this process holds. */
  gate: MaintenanceGate;
  plan: MigrationPlan;
  /** instanceId of control/instance.json. */
  instanceId: string;
  busyTimeoutMs: number;
  /** Builds the snapshot port for the source connection the upgrade is about to change. */
  createSnapshots: (source: SqliteConnection) => DatabaseSnapshotPort;
  now: () => string;
  newOperationId: () => string;
}>;

const refused = (code: DatabaseOpenCode, fields: readonly string[]): DatabaseOpenResult => ({ ok: false, code, fields });
const RECOVERY_REQUIRED = refused("MAINTENANCE_RECOVERY_REQUIRED", ["activeOperation"]);

const openWriter = (inputs: DatabaseOpenInputs): SqliteConnection =>
  openDatabase(inputs.file, { role: "writer", busyTimeoutMs: inputs.busyTimeoutMs });

/** Opens the writer, runs `step` with it and closes it again if the step throws. */
function withWriter(inputs: DatabaseOpenInputs, step: (connection: SqliteConnection) => void): SqliteConnection {
  const connection = openWriter(inputs);
  try {
    step(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

/** Initializes inside the given `init` operation and closes it only after the commit. */
function initialize(inputs: DatabaseOpenInputs, operationId: string, generation: number): DatabaseOpenResult {
  const connection = withWriter(inputs, (writer) => {
    initializeDatabase(writer, inputs.plan, { instanceId: inputs.instanceId, createdAt: inputs.now() });
    inputs.gate.complete(operationId, generation);
  });
  return { ok: true, connection, schemaVersion: targetSchemaVersion(inputs.plan), created: true };
}

async function open(inputs: DatabaseOpenInputs): Promise<DatabaseOpenResult> {
  validatePlan(inputs.plan);
  const target = targetSchemaVersion(inputs.plan);
  const state = inputs.gate.current();
  const active = state.activeOperation;
  // Only an init or an upgrade towards this very plan can be reconciled here; a standalone
  // snapshot operation has no owner before the backup jobs (D48/D49).
  const reconcilable =
    active !== null &&
    ((active.reason === "init" && active.targetSchemaVersion === target) || (active.reason === "migrate" && active.toSchemaVersion === target));
  if (active !== null && !reconcilable) {
    return RECOVERY_REQUIRED;
  }
  const inspection = inspectDatabase(inputs.file, inputs.plan, { instanceId: inputs.instanceId, busyTimeoutMs: inputs.busyTimeoutMs });

  if (active?.reason === "migrate") {
    return resumeMigration(inputs, active, state.generation, inspection);
  }
  if (active !== null) {
    if (inspection.kind === "empty") {
      return initialize(inputs, active.operationId, state.generation);
    }
    if (inspection.kind === "current") {
      // The init committed before the crash; only closing the operation was lost.
      const connection = withWriter(inputs, () => inputs.gate.complete(active.operationId, state.generation));
      return { ok: true, connection, schemaVersion: inspection.schemaVersion, created: false };
    }
    return RECOVERY_REQUIRED;
  }

  switch (inspection.kind) {
    case "refused":
      return refused(inspection.code, inspection.fields);
    case "current":
      return { ok: true, connection: openWriter(inputs), schemaVersion: inspection.schemaVersion, created: false };
    case "empty": {
      // A gate that has recorded an operation belongs to an installation that had a database:
      // its absence is lost data or a missing mount, never a new installation.
      if (state.generation !== 0) {
        return refused("DATABASE_MISSING", [DATABASE_FIELD]);
      }
      const operationId = inputs.newOperationId();
      const begun = inputs.gate.begin({ operationId, reason: "init", phase: "initializing", startedAt: inputs.now(), targetSchemaVersion: target });
      return initialize(inputs, operationId, begun.generation);
    }
    case "pending":
      return beginUpgrade(inputs, inspection.fromSchemaVersion, inspection.toSchemaVersion);
  }
}

type MigrateOperation = Extract<MaintenanceOperation, { reason: "migrate" }>;

/**
 * The file decides what a crashed upgrade left: version `to` means the migration committed and
 * only closing the operation was lost; version `from` means nothing of it was kept (one
 * transaction), so the same operation continues. Any other state needs a human.
 */
async function resumeMigration(
  inputs: DatabaseOpenInputs,
  operation: MigrateOperation,
  generation: number,
  inspection: ReturnType<typeof inspectDatabase>,
): Promise<DatabaseOpenResult> {
  if (inspection.kind === "current" && operation.phase !== "snapshot") {
    const connection = withWriter(inputs, () => inputs.gate.complete(operation.operationId, generation));
    return { ok: true, connection, schemaVersion: inspection.schemaVersion, created: false };
  }
  if (
    inspection.kind === "pending" &&
    operation.phase !== "verifying" &&
    inspection.fromSchemaVersion === operation.fromSchemaVersion &&
    inspection.toSchemaVersion === operation.toSchemaVersion
  ) {
    return upgrade(inputs, operation, generation, true);
  }
  return RECOVERY_REQUIRED;
}

/** A new `migrate` operation for the pending upgrade. */
function beginUpgrade(inputs: DatabaseOpenInputs, fromSchemaVersion: number, toSchemaVersion: number): Promise<DatabaseOpenResult> {
  const operation = { operationId: inputs.newOperationId(), reason: "migrate", startedAt: inputs.now(), fromSchemaVersion, toSchemaVersion } as const;
  const { generation } = inputs.gate.begin({ ...operation, phase: "snapshot", snapshotId: null });
  return upgrade(inputs, { ...operation, phase: "snapshot", snapshotId: null }, generation, false);
}

/** Snapshot of the old version (new, or recognized again after a crash) → migrate → check → close. */
async function upgrade(inputs: DatabaseOpenInputs, operation: MigrateOperation, generation: number, resuming: boolean): Promise<DatabaseOpenResult> {
  const { operationId, fromSchemaVersion, toSchemaVersion, startedAt } = operation;
  const base = { operationId, reason: "migrate", startedAt, fromSchemaVersion, toSchemaVersion } as const;
  const connection = openWriter(inputs);
  try {
    const snapshots = inputs.createSnapshots(connection);
    // A crash after publication leaves a finished snapshot of this very operation. The database
    // has not changed since (the operation never got past its snapshot or rolled back), so the
    // snapshot is recognized, verified again and used instead of taking a second one.
    const published = resuming ? await snapshots.findPublished(operationId) : undefined;
    let snapshotId: string | undefined;
    if (published?.schemaVersion === fromSchemaVersion) {
      await snapshots.discardUnpublished();
      snapshotId = published.snapshotId;
    } else {
      const snapshot = await snapshots.create({ reason: "pre_migration", scope: "database", operationId, fence: generation });
      snapshotId = snapshot.ok ? snapshot.snapshotId : undefined;
    }
    if (snapshotId === undefined) {
      // Nothing was changed: the operation closes and the database stays at its version.
      inputs.gate.complete(operationId, generation);
      connection.close();
      return refused("MIGRATION_SNAPSHOT_REQUIRED", ["schemaVersion"]);
    }
    inputs.gate.advance({ ...base, phase: "migrating", snapshotId });
    try {
      migrateDatabase(connection, inputs.plan, inputs.now());
    } catch (error) {
      if (!(error instanceof MigrationFailedError)) {
        throw error;
      }
      // Rolled back as a whole: the database is still at its version, the snapshot stays.
      inputs.gate.complete(operationId, generation);
      connection.close();
      return refused("MIGRATION_FAILED", [error.migrationId]);
    }
    inputs.gate.advance({ ...base, phase: "verifying", snapshotId });
    const after = inspectDatabase(inputs.file, inputs.plan, { instanceId: inputs.instanceId, busyTimeoutMs: inputs.busyTimeoutMs });
    if (after.kind !== "current") {
      // Committed but not what the plan says: nothing automatic may judge that.
      connection.close();
      return RECOVERY_REQUIRED;
    }
    inputs.gate.complete(operationId, generation);
    return { ok: true, connection, schemaVersion: after.schemaVersion, created: false };
  } catch (error) {
    connection.close();
    throw error;
  }
}

/**
 * The bootstrap step between the gate and HTTP. Expected refusals and driver failures become a
 * code with fields; an invalid plan is a programming error and propagates.
 */
export async function openInstallationDatabase(inputs: DatabaseOpenInputs): Promise<DatabaseOpenResult> {
  try {
    return await open(inputs);
  } catch (error) {
    if (error instanceof MigrationPlanError) {
      throw error;
    }
    return refused("DATABASE_UNAVAILABLE", [error instanceof ConnectionSettingError ? error.setting : DATABASE_FIELD]);
  }
}
