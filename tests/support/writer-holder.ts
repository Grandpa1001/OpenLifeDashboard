// node tests/support/writer-holder.ts <installation dir> [--begin init|snapshot] [--complete] [--spawn-child]
// Test-only writer process (DEV D04.1): takes the writer lease and opens the maintenance gate
// through the built server adapters, optionally begins (and completes) a maintenance operation
// or spawns a long-lived child, prints one JSON line and stays alive until it is killed. Tests
// use it to leave a real unfinished operation or a surviving child behind a killed writer: an
// `init` is reconciled by the next start (D04.3), a `snapshot` stays unrecoverable until D05.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { installationWorkingPaths } from "../../apps/server/dist/adapters/filesystem/installation-paths.js";
import { openMaintenanceGate } from "../../apps/server/dist/adapters/filesystem/maintenance-gate.js";
import { acquireWriterLease } from "../../apps/server/dist/adapters/filesystem/writer-lease.js";

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error("usage: writer-holder <installation dir> [--begin init|snapshot] [--complete] [--spawn-child]");
  process.exit(2);
}
const paths = installationWorkingPaths(dir);
const writer = acquireWriterLease(paths.maintenance);
if (!writer.ok) {
  console.log(JSON.stringify({ event: "holder.refused", code: writer.code }));
  process.exit(1);
}
const opened = openMaintenanceGate(writer.lease, paths);
if (!opened.ok) {
  console.log(JSON.stringify({ event: "holder.refused", code: opened.code, fields: opened.fields }));
  process.exit(1);
}
let operationId: string | null = null;
const reason = flags[flags.indexOf("--begin") + 1];
if (flags.includes("--begin")) {
  operationId = randomUUID();
  const startedAt = new Date().toISOString();
  const state = opened.gate.begin(
    reason === "init"
      ? { operationId, reason, phase: "initializing", startedAt, targetSchemaVersion: 1 }
      : { operationId, reason: "snapshot", phase: "staging", startedAt, snapshotId: `holder-${operationId}` },
  );
  if (flags.includes("--complete")) {
    opened.gate.complete(operationId, state.generation);
  }
}
// A child that outlives this process; it must not keep the lease (Architektura §4.8).
const child = flags.includes("--spawn-child")
  ? spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" })
  : undefined;
child?.unref();
console.log(JSON.stringify({ event: "holder.ready", generation: opened.gate.current().generation, operationId, childPid: child?.pid ?? null }));
setInterval(() => {}, 60_000);
