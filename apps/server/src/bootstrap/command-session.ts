// The installation as an administrative command (create-owner, reset-password) sees it
// (Architektura §4.8): the same configuration, storage preflight, writer lease and maintenance
// gate as the server, then a writer connection to a database that is already current. A command
// never initializes, migrates or snapshots: a missing database, a pending upgrade or an active
// maintenance operation is refused with a code. A running app holds the lease, so the command
// meets INSTANCE_BUSY and changes nothing.
import { openDatabase, type SqliteConnection } from "@openlife/sqlite/connection";
import { DATABASE_FIELD, inspectDatabase, PRODUCT_MIGRATION_PLAN, type DatabaseRefusalCode } from "@openlife/sqlite/migrations";
import { checkAuthSchema } from "../adapters/auth/auth-schema.js";
import { CONTAINER_WORKING_PATHS, installationWorkingPaths } from "../adapters/filesystem/installation-paths.js";
import { openMaintenanceGate, type GateOpenResult } from "../adapters/filesystem/maintenance-gate.js";
import { runStoragePreflight, type PreflightResult } from "../adapters/filesystem/storage-preflight.js";
import { acquireWriterLease, type WriterLeaseResult } from "../adapters/filesystem/writer-lease.js";
import { loadBootstrapConfig, type BootstrapResult } from "./bootstrap-config.js";

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
}>;

const refused = (code: CommandSessionCode, fields: readonly string[]): CommandSessionResult => ({ ok: false, code, fields });

export function openCommandSession(inputs: CommandSessionInputs): CommandSessionResult {
  const workingPaths = inputs.installationDir === undefined ? CONTAINER_WORKING_PATHS : installationWorkingPaths(inputs.installationDir);
  const bootstrap = loadBootstrapConfig({ env: inputs.env, instanceFile: workingPaths.instanceFile });
  if (!bootstrap.ok) {
    return refused(bootstrap.code, bootstrap.fields);
  }
  const { environment, paths, settings } = bootstrap.config;
  const reserveMiB = settings.find((setting) => setting.key === DISK_RESERVE_KEY)?.value;
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
  let connection: SqliteConnection | undefined;
  let handedOver = false;
  try {
    const gate = openMaintenanceGate(writer.lease, workingPaths);
    if (!gate.ok) {
      return refused(gate.code, gate.fields);
    }
    if (gate.gate.current().activeOperation !== null) {
      return refused("MAINTENANCE_RECOVERY_REQUIRED", ["activeOperation"]);
    }
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
    const opened = openDatabase(workingPaths.database, { role: "writer", busyTimeoutMs: environment.dbBusyTimeoutMs });
    connection = opened;
    const authSchema = checkAuthSchema(opened);
    if (!authSchema.ok) {
      return refused(authSchema.code, authSchema.fields);
    }
    handedOver = true;
    return {
      ok: true,
      session: {
        connection: opened,
        close: () => {
          opened.close();
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
