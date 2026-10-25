// node tests/support/database-holder.ts <installation dir> a|b|slow
// Test-only writer (DEV D04.3): runs the server's bootstrap database step with a harness plan
// on a real installation — writer lease, maintenance gate, then openInstallationDatabase — and
// prints one JSON line with its result before closing the database and exiting. The server
// itself always uses plan A; this process plays the "other image" of upgrade and crash tests.
import { randomUUID } from "node:crypto";
import { installationWorkingPaths } from "../../apps/server/dist/adapters/filesystem/installation-paths.js";
import { openMaintenanceGate } from "../../apps/server/dist/adapters/filesystem/maintenance-gate.js";
import { acquireWriterLease } from "../../apps/server/dist/adapters/filesystem/writer-lease.js";
import { openInstallationDatabase, SNAPSHOTS_UNAVAILABLE } from "../../apps/server/dist/bootstrap/database.js";
import { readInstanceMetadata } from "../../apps/server/dist/bootstrap/instance-metadata.js";
import { PLANS } from "./migration-plans.ts";

const [dir, planName = ""] = process.argv.slice(2);
const plan = PLANS[planName];
if (!dir || !plan) {
  console.error("usage: database-holder <installation dir> a|b|slow");
  process.exit(2);
}
const paths = installationWorkingPaths(dir);
const metadata = readInstanceMetadata(paths.instanceFile);
const writer = acquireWriterLease(paths.maintenance);
const gate = writer.ok ? openMaintenanceGate(writer.lease, paths) : undefined;
if (!metadata.ok || !writer.ok || !gate?.ok) {
  console.log(JSON.stringify({ event: "database.refused", code: "PRECONDITION" }));
  process.exit(1);
}
const result = await openInstallationDatabase({
  file: paths.database,
  gate: gate.gate,
  plan,
  instanceId: metadata.metadata.instanceId,
  busyTimeoutMs: 5000,
  snapshots: SNAPSHOTS_UNAVAILABLE,
  now: () => new Date().toISOString(),
  newOperationId: randomUUID,
});
if (result.ok) {
  console.log(JSON.stringify({ event: "database.opened", schemaVersion: result.schemaVersion, created: result.created }));
  result.connection.close();
} else {
  console.log(JSON.stringify({ event: "database.refused", code: result.code, fields: result.fields }));
}
writer.lease.release();
process.exitCode = result.ok ? 0 : 1;
