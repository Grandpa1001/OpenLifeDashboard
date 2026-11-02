// `node apps/server/dist/cli/restore-registry.js [--installation <dir>]` with
// `{"snapshot": "<package directory>", "symbol": "<registry>"}` on stdin — restores one deleted registry
// from its copy pre_delete (Scope §5.6, S10; Architektura §5.2, §11.3.3; D30.2). Like the other
// commands it runs under the writer lease on a current database, so a running app means INSTANCE_BUSY
// and no change. The package is looked up by name in the installation's backup folder and verified as a
// restore of the whole instance would verify it (files, checksums, meta, integrity); it must be a copy
// pre_delete of this installation at the schema version of its database. The registry is read from the
// copy through a read-only connection of its own and goes back in one transaction (restoreRegistry): the
// same identifiers, rows, times and revisions, and only over its own deletion. No copy pre_restore is
// taken first: the restore writes nothing that exists, any conflict refuses it, and a failure leaves
// the database as it was. A refusal names a code and fields, never a value.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DATABASE_SNAPSHOT_FILES, restoreRegistryInputSchema } from "@openlife/contracts/backups/database-snapshot";
import { restoreRegistry } from "@openlife/core/registries";
import { bindAppendAudit } from "@openlife/sqlite/adapters/audit";
import { bindRegistryStore, bindRegistryTables, openRegistryCopy } from "@openlife/sqlite/adapters/registries";
import { createUnitOfWork } from "@openlife/sqlite/transactions";
import { verifyDatabaseSnapshot } from "../adapters/filesystem/database-snapshots.js";
import { describeError } from "../adapters/logging/describe-error.js";
import { openCommandSession } from "../bootstrap/command-session.js";
import { readJsonInput, refuse as refuseCommand } from "./command-io.js";
import { parseCommandOptions } from "./command-options.js";

const EVENT = "restore-registry.failed";
function refuse(code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  return refuseCommand(EVENT, code, fields, details);
}

const options = parseCommandOptions(process.argv.slice(2));
if (!options.ok) {
  refuse("USAGE", ["arguments"]);
}
const input = await readJsonInput(EVENT, restoreRegistryInputSchema);
const requestId = randomUUID();
const opened = openCommandSession({ env: process.env, installationDir: options.installationDir });
if (!opened.ok) {
  refuse(opened.code, opened.fields);
}
const { session } = opened;
let copy: ReturnType<typeof openRegistryCopy> | undefined;
try {
  const dir = path.join(session.backupsDir, input.snapshot);
  const verification = verifyDatabaseSnapshot(dir);
  if (!verification.ok) {
    refuse(verification.code, verification.fields);
  }
  const { meta } = verification;
  const unsuitable = [meta.instanceId === session.instanceId ? [] : ["instanceId"], meta.reason === "pre_delete" ? [] : ["reason"], meta.schemaVersion === session.schemaVersion ? [] : ["schemaVersion"]].flat();
  if (unsuitable.length > 0) {
    refuse("SNAPSHOT_UNSUITABLE", unsuitable);
  }
  copy = openRegistryCopy(path.join(dir, DATABASE_SNAPSHOT_FILES.database), input.symbol);
  const registry = copy.registry;
  if (registry === null) {
    refuse("RESTORE_CONFLICT", ["symbol"]);
  }
  const unit = createUnitOfWork(session.connection, (tx) => ({ registries: bindRegistryStore(tx), tables: bindRegistryTables(tx), audit: bindAppendAudit(tx) }));
  const restored = unit.run((ports) => restoreRegistry(ports, { copy: { registry, pages: copy!.pages() }, snapshotId: meta.snapshotId, nowIso: new Date().toISOString(), requestId }));
  if (!restored.ok) {
    refuse(restored.error.code, restored.error.fields ?? []);
  }
  const { registryId, schemaRevision, records } = restored.value.value;
  console.log(JSON.stringify({ event: "registry.restored", symbol: input.symbol, registryId, schemaRevision, records, snapshotId: meta.snapshotId, requestId }));
} catch (error) {
  // The unit has rolled back; the error is described by class and code only.
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
} finally {
  copy?.close();
  session.close();
}
