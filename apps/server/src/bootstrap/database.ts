// Opening the installation database under the writer lease (Architektura §4.8; D04.3). The
// file is inspected before the writer opens it. An empty database is initialized as an `init`
// operation of the maintenance gate; an `init` interrupted by a crash is reconciled from the
// database itself (empty → initialize again, complete → close the operation). Any other active
// operation, a foreign or newer database, a changed migration or another instance's database
// refuses the start. Upgrading an existing database needs a verified pre_migration snapshot;
// until its provider exists (D05) the snapshot port refuses and so does the upgrade.
import type { DatabaseSnapshotPort } from "@openlife/core/maintenance";
import { ConnectionSettingError, openDatabase, type SqliteConnection } from "@openlife/sqlite/connection";
import {
  DATABASE_FIELD,
  initializeDatabase,
  inspectDatabase,
  MigrationPlanError,
  targetSchemaVersion,
  validatePlan,
  type DatabaseRefusalCode,
  type MigrationPlan,
} from "@openlife/sqlite/migrations";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";

export type DatabaseOpenCode =
  | DatabaseRefusalCode
  | "MAINTENANCE_RECOVERY_REQUIRED"
  | "MIGRATION_SNAPSHOT_REQUIRED"
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
  snapshots: DatabaseSnapshotPort;
  now: () => string;
  newOperationId: () => string;
}>;

/** The snapshot provider before D05: every request is refused, so no existing database migrates. */
export const SNAPSHOTS_UNAVAILABLE: DatabaseSnapshotPort = {
  create: () => Promise.resolve({ ok: false, code: "SNAPSHOT_UNAVAILABLE" }),
};

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
  // Only an init of this very plan can be reconciled here; migrate/snapshot reconcile in D05.
  if (active !== null && (active.reason !== "init" || active.targetSchemaVersion !== target)) {
    return RECOVERY_REQUIRED;
  }
  const inspection = inspectDatabase(inputs.file, inputs.plan, { instanceId: inputs.instanceId, busyTimeoutMs: inputs.busyTimeoutMs });

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
    case "pending": {
      const operationId = inputs.newOperationId();
      const begun = inputs.gate.begin({
        operationId,
        reason: "migrate",
        phase: "snapshot",
        startedAt: inputs.now(),
        fromSchemaVersion: inspection.fromSchemaVersion,
        toSchemaVersion: inspection.toSchemaVersion,
        snapshotId: null,
      });
      const snapshot = await inputs.snapshots.create({ reason: "pre_migration", scope: "database", operationId, fence: begun.generation });
      // Nothing was changed: the operation closes and the database stays at its version.
      inputs.gate.complete(operationId, begun.generation);
      if (!snapshot.ok) {
        return refused("MIGRATION_SNAPSHOT_REQUIRED", ["schemaVersion"]);
      }
      // Applying the migrations after a verified snapshot is D05.2; no provider succeeds before it.
      throw new Error("upgrading an existing database arrives with D05.2");
    }
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
