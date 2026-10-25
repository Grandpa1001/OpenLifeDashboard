// Runs INSIDE the app image as a one-off container of the installation (docker compose run), with
// the installation's mounts and while the app is stopped (DEV D07.2): takes the writer lease and
// the maintenance gate like any tool that changes the database, makes a database snapshot with the
// real adapter and prints its ID. This is what a manual `backup create` will do (D48).
import console from "node:console";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const dist = "/app/apps/server/dist";
const fromDist = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
const requireFromServer = createRequire(path.join(dist, "main.js"));
const fromPackage = (name) => import(pathToFileURL(requireFromServer.resolve(name)).href);

const { CONTAINER_WORKING_PATHS: paths } = await fromDist("adapters/filesystem/installation-paths.js");
const { readInstanceMetadata } = await fromDist("bootstrap/instance-metadata.js");
const { acquireWriterLease } = await fromDist("adapters/filesystem/writer-lease.js");
const { openMaintenanceGate } = await fromDist("adapters/filesystem/maintenance-gate.js");
const { createDatabaseSnapshots } = await fromDist("adapters/filesystem/database-snapshots.js");
const { readBuildInfo } = await fromDist("bootstrap/build-info.js");
const { openDatabase } = await fromPackage("@openlife/sqlite/connection");

const metadata = readInstanceMetadata(paths.instanceFile);
const lease = acquireWriterLease(paths.maintenance);
if (!metadata.ok || !lease.ok) {
  console.log(JSON.stringify({ event: "snapshot.refused", code: lease.ok ? "INSTANCE_METADATA_INVALID" : lease.code }));
  process.exit(1);
}
const gate = openMaintenanceGate(lease.lease, paths);
if (!gate.ok) {
  console.log(JSON.stringify({ event: "snapshot.refused", code: gate.code }));
  process.exit(1);
}
const source = openDatabase(paths.database, { role: "writer", busyTimeoutMs: 5000 });
const snapshots = createDatabaseSnapshots(source, {
  backupsDir: paths.backups,
  reserveMiB: 128,
  instanceId: metadata.metadata.instanceId,
  build: readBuildInfo(),
  now: () => new Date().toISOString(),
  newSnapshotId: randomUUID,
});
const result = await snapshots.create({ reason: "pre_migration", scope: "database", operationId: randomUUID(), fence: gate.gate.current().generation });
source.close();
lease.lease.release();
console.log(JSON.stringify(result.ok ? { event: "snapshot.created", snapshotId: result.snapshotId } : { event: "snapshot.refused", code: result.code }));
process.exit(result.ok ? 0 : 1);
