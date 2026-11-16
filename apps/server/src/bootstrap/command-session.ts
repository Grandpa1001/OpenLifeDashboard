// The installation as an administrative command (create-owner, reset-password) sees it
// (Architektura §4.8): the same configuration, storage preflight, writer lease and maintenance
// gate as the server, then a writer connection to a database that is already current. A command
// never initializes, migrates or snapshots: a missing database, a pending upgrade or an active
// maintenance operation is refused with a code. A running app holds the lease, so the command
// meets INSTANCE_BUSY and changes nothing.
import { integerSetting } from "@openlife/core/settings";
import { openDatabase, type SqliteConnection } from "@openlife/sqlite/connection";
import { DATABASE_FIELD, inspectDatabase, PRODUCT_MIGRATION_PLAN, type DatabaseRefusalCode } from "@openlife/sqlite/migrations";
import { checkAuthSchema } from "../adapters/auth/auth-schema.js";
import { CONTAINER_WORKING_PATHS, installationWorkingPaths, type InstallationPaths, type WorkingPaths } from "../adapters/filesystem/installation-paths.js";
import { openMaintenanceGate, type GateOpenResult, type MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";
import { runStoragePreflight, type PreflightResult } from "../adapters/filesystem/storage-preflight.js";
import { acquireWriterLease, type WriterLeaseResult } from "../adapters/filesystem/writer-lease.js";
import { loadBootstrapConfig, type BootstrapResult } from "./bootstrap-config.js";
import type { EnvironmentConfig } from "./environment.js";

const DISK_RESERVE_KEY = "backup.diskReserveMiB";

type FailureCode<R> = R extends Readonly<{ ok: false; code: infer C }> ? C : never;

export type CommandSessionCode =
  | FailureCode<BootstrapResult>
  | FailureCode<PreflightResult>
  | FailureCode<WriterLeaseResult>
  | FailureCode<GateOpenResult>
  | DatabaseRefusalCode
  | "DATABASE_MISSING"
  | "DATABASE_NOT_CURRENT"
  | "MAINTENANCE_RECOVERY_REQUIRED"
  | "AUTH_SCHEMA_INCOMPATIBLE";

export type CommandSession = Readonly<{
  connection: SqliteConnection;
  /** The installation's identity, the schema version of its database and its folder of copies (restore-registry, D30.2). */
  instanceId: string;
  schemaVersion: number;
  backupsDir: string;
  /** backup.diskReserveMiB: the free space a copy must leave (backup-create, D48.2). */
  reserveMiB: number;
  /** DB_BUSY_TIMEOUT_MS, for the readers a command opens besides the writer. */
  busyTimeoutMs: number;
  /** Closes the connection and releases the lease. */
  close: () => void;
}>;

export type CommandSessionResult =
  | Readonly<{ ok: true; session: CommandSession }>
  | Readonly<{ ok: false; code: CommandSessionCode; fields: readonly string[] }>;

export type CommandSessionInputs = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  /** Installation folder outside a container; absent = the fixed container paths. */
  installationDir?: string | undefined;
  /** The operation of an update that this command ends (restore-instance, D56.1): an active `update` of this id does not refuse the command. */
  endsUpdate?: string | undefined;
}>;

type Refusal = Readonly<{ ok: false; code: CommandSessionCode; fields: readonly string[] }>;
const refused = (code: CommandSessionCode, fields: readonly string[]): Refusal => ({ ok: false, code, fields });

/** The installation up to the writer lease and a quiet maintenance gate, without a look at the database: what a command that replaces the database needs (restore-instance, D50.2) and what every other command builds on. */
export type OpenedInstallation = Readonly<{
  workingPaths: WorkingPaths;
  environment: EnvironmentConfig;
  paths: InstallationPaths;
  reserveMiB: number;
  /** Held until the caller releases it. */
  writer: Extract<WriterLeaseResult, { ok: true }>;
  /** The maintenance gate under that lease, for a command that ends an operation (D56.1). */
  gate: MaintenanceGate;
}>;

export type OpenInstallationResult = Readonly<{ ok: true; installation: OpenedInstallation }> | Refusal;

export function openInstallation(inputs: CommandSessionInputs): OpenInstallationResult {
  const workingPaths = inputs.installationDir === undefined ? CONTAINER_WORKING_PATHS : installationWorkingPaths(inputs.installationDir);
  const bootstrap = loadBootstrapConfig({ env: inputs.env, instanceFile: workingPaths.instanceFile });
  if (!bootstrap.ok) {
    return refused(bootstrap.code, bootstrap.fields);
  }
  const { environment, paths, settings } = bootstrap.config;
  const reserveMiB = integerSetting(settings, DISK_RESERVE_KEY);
  if (reserveMiB === undefined) {
    return refused("CONFIG_INVALID", [DISK_RESERVE_KEY]);
  }
  const preflight = runStoragePreflight(workingPaths, reserveMiB);
  if (!preflight.ok) {
    return refused(preflight.code, preflight.fields);
  }
  const writer = acquireWriterLease(workingPaths.maintenance);
  if (!writer.ok) {
    return refused(writer.code, writer.fields);
  }
  const gate = openMaintenanceGate(writer.lease, workingPaths);
  if (!gate.ok) {
    writer.lease.release();
    return refused(gate.code, gate.fields);
  }
  const active = gate.gate.current().activeOperation;
  if (active !== null && !(active.reason === "update" && inputs.endsUpdate !== undefined && active.operationId === inputs.endsUpdate)) {
    writer.lease.release();
    return refused("MAINTENANCE_RECOVERY_REQUIRED", ["activeOperation"]);
  }
  return { ok: true, installation: { workingPaths, environment, paths, reserveMiB, writer, gate: gate.gate } };
}

export function openCommandSession(inputs: CommandSessionInputs): CommandSessionResult {
  const opened = openInstallation(inputs);
  if (!opened.ok) {
    return opened;
  }
  const { workingPaths, environment, paths, reserveMiB, writer } = opened.installation;
  let connection: SqliteConnection | undefined;
  let handedOver = false;
  try {
    const inspection = inspectDatabase(workingPaths.database, PRODUCT_MIGRATION_PLAN, {
      instanceId: paths.instanceId,
      busyTimeoutMs: environment.dbBusyTimeoutMs,
    });
    if (inspection.kind === "refused") {
      return refused(inspection.code, inspection.fields);
    }
    if (inspection.kind !== "current") {
      return refused(inspection.kind === "empty" ? "DATABASE_MISSING" : "DATABASE_NOT_CURRENT", [DATABASE_FIELD]);
    }
    const database = openDatabase(workingPaths.database, { role: "writer", busyTimeoutMs: environment.dbBusyTimeoutMs });
    connection = database;
    const authSchema = checkAuthSchema(database);
    if (!authSchema.ok) {
      return refused(authSchema.code, authSchema.fields);
    }
    handedOver = true;
    return {
      ok: true,
      session: {
        connection: database,
        instanceId: paths.instanceId,
        schemaVersion: inspection.schemaVersion,
        backupsDir: workingPaths.backups,
        reserveMiB,
        busyTimeoutMs: environment.dbBusyTimeoutMs,
        close: () => {
          database.close();
          writer.lease.release();
        },
      },
    };
  } finally {
    // Every refusal and every failure leaves nothing open; a session is closed by its caller.
    if (!handedOver) {
      connection?.close();
      writer.lease.release();
    }
  }
}
