// Durable maintenance gate (Architektura §4.8, §11.4): control/maintenance/state.json records
// the operation in progress outside the database. It is read and written only under the writer
// lease, and it is not the lease: after a crash the next process recovers the lock, but an
// unknown or unreadable gate keeps writes closed, and an operation left active must be
// reconciled by the bootstrap (bootstrap/database.ts) before anything else writes.
// A missing file is initialized only for a new installation without a database; it is never a
// repair of an existing one. Every change goes through staging, fsync, rename and a directory
// fsync on the same mount, so a crash leaves either the old or the new state.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  MAINTENANCE_STATE_FORMAT_VERSION,
  maintenanceOperationSchema,
  maintenanceStateSchema,
  type MaintenanceOperation,
  type MaintenanceState,
} from "@openlife/contracts/workers/maintenance-state";
import { syncDirectory, writeNewFileDurably } from "./durable-files.js";
import type { WriterLease } from "./writer-lease.js";

/** Gate file inside the maintenance mount; the field name reported for an unreadable gate. */
export const MAINTENANCE_STATE_FILE = "state.json";
const STAGING_FILE = `${MAINTENANCE_STATE_FILE}.staging`;
/** The database and the companion files SQLite keeps next to it. */
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"];
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export type MaintenanceGate = Readonly<{
  current: () => MaintenanceState;
  /**
   * Persists the next generation with the operation before the caller mutates anything; the
   * returned generation is the operation's fence. Requires the held lease and no active operation.
   */
  begin: (operation: MaintenanceOperation) => MaintenanceState;
  /**
   * Persists a later phase of the active operation (same ID and reason, same generation), so a
   * crash leaves the phase that was reached for reconciliation. Another operation is refused.
   */
  advance: (operation: MaintenanceOperation) => MaintenanceState;
  /** Closes the operation that `begin` returned; another ID or generation is refused. */
  complete: (operationId: string, generation: number) => MaintenanceState;
}>;

export type GateOpenResult =
  | Readonly<{ ok: true; gate: MaintenanceGate; initialized: boolean }>
  | Readonly<{ ok: false; code: "MAINTENANCE_RECOVERY_REQUIRED" | "STORAGE_UNWRITABLE"; fields: readonly string[] }>;

type ReadOutcome =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid"; fields: readonly string[] }>
  | Readonly<{ kind: "valid"; state: MaintenanceState }>;

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Top-level fields to fix; like instance.json, an unknown format version is reported alone. */
function invalidFields(raw: unknown, issues: readonly { code: string; path: readonly PropertyKey[]; keys?: readonly string[] }[]): string[] {
  if (!isRecord(raw)) {
    return [MAINTENANCE_STATE_FILE];
  }
  if (raw["formatVersion"] !== MAINTENANCE_STATE_FORMAT_VERSION) {
    return ["formatVersion"];
  }
  const fields = issues.flatMap((issue) =>
    issue.path.length === 0 ? [...(issue.keys ?? [MAINTENANCE_STATE_FILE])] : [String(issue.path[0])],
  );
  return [...new Set(fields)].sort();
}

function readState(file: string): ReadOutcome {
  let text: string;
  try {
    const fd = openSync(file, READ_FLAGS);
    try {
      if (!fstatSync(fd).isFile()) {
        return { kind: "invalid", fields: [MAINTENANCE_STATE_FILE] };
      }
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return hasCode(error, "ENOENT") ? { kind: "missing" } : { kind: "invalid", fields: [MAINTENANCE_STATE_FILE] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", fields: [MAINTENANCE_STATE_FILE] };
  }
  const parsed = maintenanceStateSchema.safeParse(raw);
  return parsed.success ? { kind: "valid", state: parsed.data } : { kind: "invalid", fields: invalidFields(raw, parsed.error.issues) };
}

/** No database file and no SQLite companion: the only case where a missing gate is created. */
function isNewInstallation(databaseFile: string): boolean {
  return DATABASE_FILE_SUFFIXES.every((suffix) => {
    try {
      lstatSync(`${databaseFile}${suffix}`);
      return false;
    } catch (error) {
      return hasCode(error, "ENOENT");
    }
  });
}

function persist(dir: string, state: MaintenanceState): void {
  const staging = path.join(dir, STAGING_FILE);
  // A staging file left by a crash is this gate's own; anything else in its place is refused.
  try {
    if (!lstatSync(staging).isFile()) {
      throw new Error(`${STAGING_FILE} is not a regular file`);
    }
    unlinkSync(staging);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  writeNewFileDurably(staging, `${JSON.stringify(state)}\n`);
  renameSync(staging, path.join(dir, MAINTENANCE_STATE_FILE));
  syncDirectory(dir);
}

function createGate(lease: WriterLease, dir: string, initial: MaintenanceState): MaintenanceGate {
  let state = initial;
  const write = (next: MaintenanceState): MaintenanceState => {
    if (!lease.isHeld()) {
      throw new Error("the maintenance gate changes only under the held writer lease");
    }
    persist(dir, next);
    state = next;
    return state;
  };
  return {
    current: () => state,
    begin: (operation) => {
      if (state.activeOperation !== null) {
        throw new Error(`operation ${state.activeOperation.operationId} is still active`);
      }
      return write({ ...state, generation: state.generation + 1, activeOperation: maintenanceOperationSchema.parse(operation) });
    },
    advance: (operation) => {
      const active = state.activeOperation;
      if (active === null || active.operationId !== operation.operationId || active.reason !== operation.reason) {
        throw new Error(`operation ${operation.operationId} is not the active one`);
      }
      return write({ ...state, activeOperation: maintenanceOperationSchema.parse(operation) });
    },
    complete: (operationId, generation) => {
      if (state.activeOperation?.operationId !== operationId || state.generation !== generation) {
        throw new Error(`operation ${operationId} at generation ${generation} is not the active one`);
      }
      return write({ ...state, activeOperation: null });
    },
  };
}

/**
 * Reads the gate under the held lease. A valid state opens the gate also with an operation left
 * active by a crash: `current().activeOperation` tells the caller, which must reconcile it or
 * refuse with MAINTENANCE_RECOVERY_REQUIRED before writing.
 */
export function openMaintenanceGate(lease: WriterLease, paths: Readonly<{ maintenance: string; database: string }>): GateOpenResult {
  if (!lease.isHeld()) {
    throw new Error("the maintenance gate is read only under the held writer lease");
  }
  const read = readState(path.join(paths.maintenance, MAINTENANCE_STATE_FILE));
  if (read.kind === "invalid") {
    return { ok: false, code: "MAINTENANCE_RECOVERY_REQUIRED", fields: read.fields };
  }
  if (read.kind === "valid") {
    return { ok: true, gate: createGate(lease, paths.maintenance, read.state), initialized: false };
  }
  if (!isNewInstallation(paths.database)) {
    return { ok: false, code: "MAINTENANCE_RECOVERY_REQUIRED", fields: [MAINTENANCE_STATE_FILE] };
  }
  const initial: MaintenanceState = { formatVersion: MAINTENANCE_STATE_FORMAT_VERSION, generation: 0, activeOperation: null };
  try {
    persist(paths.maintenance, initial);
  } catch {
    return { ok: false, code: "STORAGE_UNWRITABLE", fields: ["maintenance"] };
  }
  return { ok: true, gate: createGate(lease, paths.maintenance, initial), initialized: true };
}
