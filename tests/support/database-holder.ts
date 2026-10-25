// node tests/support/database-holder.ts <installation dir> <plan name from migration-plans.ts> [--freeze before-publish|after-publish]
// Test-only writer (DEV D04.3): runs the server's bootstrap database step with a harness plan
// on a real installation — writer lease, maintenance gate, then openInstallationDatabase — and
// prints one JSON line with its result before closing the database and exiting. The server
// itself always uses plan A; this process plays the "other image" of upgrade and crash tests,
// with the real snapshot adapter on the installation's backup folder (DEV D05.2). With --freeze
// the process stops dead at a chosen moment of the snapshot (D05.3) after printing
// {"event":"holder.frozen"}: after the copy but before meta/checksums and publication, or right
// after publication; the test then kills it, which is what a crash at that moment leaves.
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { installationWorkingPaths } from "../../apps/server/dist/adapters/filesystem/installation-paths.js";
import { openMaintenanceGate } from "../../apps/server/dist/adapters/filesystem/maintenance-gate.js";
import { acquireWriterLease } from "../../apps/server/dist/adapters/filesystem/writer-lease.js";
import { createDatabaseSnapshots } from "../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { openInstallationDatabase } from "../../apps/server/dist/bootstrap/database.js";
import { readInstanceMetadata } from "../../apps/server/dist/bootstrap/instance-metadata.js";
import { PLANS } from "./migration-plans.ts";

const [dir, planName = "", ...flags] = process.argv.slice(2);
const freezeAt = flags[flags.indexOf("--freeze") + 1];
const plan = PLANS[planName];
if (!dir || !plan) {
  console.error(`usage: database-holder <installation dir> ${Object.keys(PLANS).join("|")}`);
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
let creating = false;
let clockReads = 0;
/** Writes the event synchronously and blocks the only thread: the process cannot finish anything. */
function freeze(): void {
  writeSync(1, `${JSON.stringify({ event: "holder.frozen", at: freezeAt })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
/** The snapshot reads the clock for startedAt and, after the copy, for completedAt (second read). */
const now = (): string => {
  if (creating && freezeAt === "before-publish" && (clockReads += 1) === 2) freeze();
  return new Date().toISOString();
};
const result = await openInstallationDatabase({
  file: paths.database,
  gate: gate.gate,
  plan,
  instanceId: metadata.metadata.instanceId,
  busyTimeoutMs: 5000,
  createSnapshots: (source) => {
    const snapshots = createDatabaseSnapshots(source, {
      backupsDir: paths.backups,
      reserveMiB: 1,
      instanceId: metadata.metadata.instanceId,
      build: { appVersion: "0.0.0-holder", buildRevision: "holder", imageDigest: null },
      now,
      newSnapshotId: randomUUID,
    });
    return {
      ...snapshots,
      async create(request) {
        creating = true;
        const created = await snapshots.create(request);
        creating = false;
        if (freezeAt === "after-publish") freeze();
        return created;
      },
    };
  },
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
