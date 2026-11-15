// `node apps/server/dist/cli/restore-instance.js [--installation <dir>]` with
// `{"snapshot": "<package directory>", "confirm": "replace-current-database"}` on stdin — restores the whole
// instance from a verified copy (Scope §5.6; Architektura §11.3.3 points 2 to 7; D50.2). It is an administrative
// tool of a stopped app: it takes the writer lease, so a running app means INSTANCE_BUSY and no change; and it
// needs no readable current database, so a damaged one can be replaced.
//  1. The package is verified in full and must be a copy of this installation at the schema version of this
//     build (a copy of an older schema is restored by the image that wrote it, so the access of the restored
//     instance is revoked on the schema it knows).
//  2. The current APP_ENCRYPTION_KEY must open the sealed secret of the copy: without the original key a
//     restored second factor would be dead.
//  3. The free space must hold the database and the reserve.
//  4. The journal outside the database says what is going on; the current set app.db, -wal and -shm moves aside
//     together, unchanged, the package's app.db takes its place through a temporary file and a rename.
//  5. In one transaction every session and trusted device is ended, the access epoch rises and the audit entry
//     `backup.restored` is written. A failure from step 4 on moves the parked set back.
// A refusal names a code and fields, never a value; the parked set is named in the answer and the journal.
import { randomUUID } from "node:crypto";
import { renameSync, statfsSync } from "node:fs";
import path from "node:path";
import { DATABASE_SNAPSHOT_FILES, restoreInstanceInputSchema } from "@openlife/contracts/backups/database-snapshot";
import { revokeAccessAfterRestore } from "@openlife/core/identity";
import { assessRestorable } from "@openlife/core/maintenance";
import { bindAppendAudit } from "@openlife/sqlite/adapters/audit";
import { bindOwnerWriters, bindSignInStores, bindTrustedDeviceStore } from "@openlife/sqlite/adapters/identity";
import { openDatabase } from "@openlife/sqlite/connection";
import { PRODUCT_MIGRATION_PLAN, targetSchemaVersion } from "@openlife/sqlite/migrations";
import { openSnapshotReader } from "@openlife/sqlite/snapshot-reader";
import { createUnitOfWork } from "@openlife/sqlite/transactions";
import { createSecretBox } from "../adapters/auth/secret-box.js";
import { writeNewFileDurably } from "../adapters/filesystem/durable-files.js";
import { restoreDatabaseFiles } from "../adapters/filesystem/instance-restore.js";
import { verifyDatabaseSnapshot } from "../adapters/filesystem/database-snapshots.js";
import { describeError } from "../adapters/logging/describe-error.js";
import { openInstallation } from "../bootstrap/command-session.js";
import { readJsonInput, refuse as refuseCommand } from "./command-io.js";
import { parseCommandOptions } from "./command-options.js";

const EVENT = "restore-instance.failed";
const MIB = 1024 * 1024;
const JOURNAL_FILE = "restore-journal.json";

function refuse(code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  return refuseCommand(EVENT, code, fields, details);
}

const options = parseCommandOptions(process.argv.slice(2));
if (!options.ok) {
  refuse("USAGE", ["arguments"]);
}
const input = await readJsonInput(EVENT, restoreInstanceInputSchema);
const requestId = randomUUID();
const opened = openInstallation({ env: process.env, installationDir: options.installationDir });
if (!opened.ok) {
  refuse(opened.code, opened.fields);
}
const { workingPaths, environment, paths, reserveMiB, writer } = opened.installation;

/** The journal of the restore lives outside the database: replaced at every state, so a crash leaves the last one. */
const journalFile = path.join(workingPaths.maintenance, JOURNAL_FILE);
const writeJournal = (state: "started" | "parked" | "restored" | "failed", extra: Readonly<Record<string, unknown>> = {}): void => {
  const pending = `${journalFile}.${requestId}`;
  writeNewFileDurably(pending, JSON.stringify({ requestId, snapshot: input.snapshot, state, at: new Date().toISOString(), ...extra }));
  renameSync(pending, journalFile);
};

try {
  const packageDir = path.join(workingPaths.backups, input.snapshot);
  const verification = verifyDatabaseSnapshot(packageDir);
  if (!verification.ok) {
    refuse(verification.code, verification.fields);
  }
  const { meta } = verification;
  const assessment = assessRestorable({ instanceId: meta.instanceId, schemaVersion: meta.schemaVersion }, { instanceId: paths.instanceId, codeSchemaVersion: targetSchemaVersion(PRODUCT_MIGRATION_PLAN) });
  const unsuitable = [assessment.sameInstallation ? [] : ["instanceId"], assessment.restorable && !assessment.migrationNeeded ? [] : ["schemaVersion"]].flat();
  if (unsuitable.length > 0) {
    refuse("SNAPSHOT_UNSUITABLE", unsuitable);
  }

  // The key: the sealed secret of the copy must open with the key this installation has now.
  const copy = openSnapshotReader(path.join(packageDir, DATABASE_SNAPSHOT_FILES.database), { busyTimeoutMs: environment.dbBusyTimeoutMs, journal: "delete" });
  let keyOpensSecret: boolean;
  try {
    const sealed = copy.tx.prepare("SELECT owner_id AS ownerId, secret_generation AS generation, active_secret AS secret FROM mfa_state WHERE singleton = 1").get() as { ownerId: string; generation: number; secret: string | null } | undefined;
    // A copy with no enrolled factor holds nothing the key protects.
    keyOpensSecret = sealed?.secret == null || createSecretBox(environment.appEncryptionKey.reveal()).open(sealed.secret, { ownerId: sealed.ownerId, generation: sealed.generation }) !== null;
  } finally {
    copy.close();
  }
  if (!keyOpensSecret) {
    refuse("KEY_MISMATCH", ["APP_ENCRYPTION_KEY"]);
  }

  const free = (() => {
    try {
      const stats = statfsSync(path.dirname(workingPaths.database));
      return stats.bavail * stats.bsize;
    } catch {
      return refuse("RESTORE_FAILED", ["storage"]);
    }
  })();
  if (free < meta.databaseBytes + reserveMiB * MIB) {
    refuse("RESTORE_LOW_SPACE", ["storage"]);
  }

  writeJournal("started");
  const parkedName = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${requestId}`;
  const placed = restoreDatabaseFiles({ databaseFile: workingPaths.database, packageDir, parkedName });
  if (!placed.ok) {
    writeJournal("failed", { code: placed.code });
    refuse(placed.code, ["storage"]);
  }
  const parked = placed.parkedDir === null ? null : path.basename(placed.parkedDir);
  writeJournal("parked", { parked });

  let connection: ReturnType<typeof openDatabase> | undefined;
  try {
    connection = openDatabase(workingPaths.database, { role: "writer", busyTimeoutMs: environment.dbBusyTimeoutMs });
    const unit = createUnitOfWork(connection, (tx) => ({ owners: bindOwnerWriters(tx).owners, sessions: bindSignInStores(tx).sessions, trusted: bindTrustedDeviceStore(tx), audit: bindAppendAudit(tx) }));
    const revoked = unit.run((ports) => revokeAccessAfterRestore(ports, { requestId, now: new Date().toISOString(), nowMs: Date.now(), snapshotId: meta.snapshotId }));
    connection.close();
    connection = undefined;
    if (!revoked.ok) {
      placed.rollback();
      writeJournal("failed", { code: revoked.error.code, parked, rolledBack: true });
      refuse(revoked.error.code, revoked.error.fields ?? []);
    }
    writeJournal("restored", { parked });
    const { accessEpoch, revokedSessions, revokedDevices } = revoked.value.value;
    console.log(JSON.stringify({ event: "instance.restored", snapshot: input.snapshot, snapshotId: meta.snapshotId, schemaVersion: meta.schemaVersion, accessEpoch, revokedSessions, revokedDevices, parked, requestId }));
  } catch (error) {
    connection?.close();
    let rolledBack = false;
    try {
      placed.rollback();
      rolledBack = true;
    } catch {
      // The set stays in the parked folder, which the answer and the journal name.
    }
    writeJournal("failed", { code: "RESTORE_FAILED", parked, rolledBack });
    refuse("RESTORE_FAILED", [], { parked, rolledBack, error: describeError(error) });
  }
} catch (error) {
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
} finally {
  writer.lease.release();
}
