// Server process entrypoint: the only place that starts HTTP (Architektura §13.1).
// Bootstrap order (§4.8, §14.5, §18.6): start options → web app → environment → instance
// metadata → option set → storage preflight → writer lease → maintenance gate → database
// (inspect, initialize, upgrade with a snapshot or reconcile) → HTTP. Any failure exits 1 before listening; a failure
// names a code and fields, never a value. Exiting releases the lease with the process; nothing
// before the lease opens or changes database files.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_MIGRATION_PLAN } from "@openlife/sqlite/migrations";
import { CONTAINER_WORKING_PATHS, installationWorkingPaths } from "./adapters/filesystem/installation-paths.js";
import { createDatabaseSnapshots } from "./adapters/filesystem/database-snapshots.js";
import { openMaintenanceGate } from "./adapters/filesystem/maintenance-gate.js";
import { runStoragePreflight } from "./adapters/filesystem/storage-preflight.js";
import { acquireWriterLease } from "./adapters/filesystem/writer-lease.js";
import { loadBootstrapConfig } from "./bootstrap/bootstrap-config.js";
import { createApp } from "./bootstrap/create-app.js";
import { readBuildInfo } from "./bootstrap/build-info.js";
import { openInstallationDatabase } from "./bootstrap/database.js";
import { startServer, stopOnSignals } from "./bootstrap/lifecycle.js";
import { SHUTDOWN_TIMEOUT_MS } from "./bootstrap/runtime-defaults.js";
import { parseStartOptions } from "./bootstrap/start-options.js";

/** The built web app sits next to the server in the workspace and in the image. */
const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const DISK_RESERVE_KEY = "backup.diskReserveMiB";

function fail(message: string): never {
  console.error(`openlife server: ${message}`);
  process.exit(1);
}

function bootstrapFailed(code: string, fields: readonly string[]): never {
  console.error(JSON.stringify({ event: "bootstrap.failed", code, fields }));
  process.exit(1);
}

const parsed = parseStartOptions(process.argv.slice(2), DEFAULT_WEB_ROOT);
if (!parsed.ok) {
  fail(parsed.message);
}
const { host, port, webRoot, installationDir } = parsed.options;

let indexHtml: string;
try {
  indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
} catch {
  fail(`web app not found at ${webRoot}; build it with "pnpm build" or pass --web-root`);
}

const workingPaths = installationDir === undefined ? CONTAINER_WORKING_PATHS : installationWorkingPaths(installationDir);
const bootstrap = loadBootstrapConfig({ env: process.env, instanceFile: workingPaths.instanceFile });
if (!bootstrap.ok) {
  bootstrapFailed(bootstrap.code, bootstrap.fields);
}
const { environment, paths, settings } = bootstrap.config;
const reserveMiB = settings.find((setting) => setting.key === DISK_RESERVE_KEY)?.value;
if (reserveMiB === undefined) {
  bootstrapFailed("CONFIG_INVALID", [DISK_RESERVE_KEY]);
}
const preflight = runStoragePreflight(workingPaths, reserveMiB);
if (!preflight.ok) {
  bootstrapFailed(preflight.code, preflight.fields);
}
if (preflight.degraded.length > 0) {
  console.error(JSON.stringify({ event: "bootstrap.degraded", code: "LOG_SINK_UNAVAILABLE", fields: preflight.degraded }));
}
const writer = acquireWriterLease(workingPaths.maintenance);
if (!writer.ok) {
  bootstrapFailed(writer.code, writer.fields);
}
const gate = openMaintenanceGate(writer.lease, workingPaths);
if (!gate.ok) {
  bootstrapFailed(gate.code, gate.fields);
}
// Read before the database step: a broken image fails here, not inside an upgrade operation.
const build = readBuildInfo();
const database = await openInstallationDatabase({
  file: workingPaths.database,
  gate: gate.gate,
  plan: PRODUCT_MIGRATION_PLAN,
  instanceId: paths.instanceId,
  busyTimeoutMs: environment.dbBusyTimeoutMs,
  createSnapshots: (source) =>
    createDatabaseSnapshots(source, {
      backupsDir: workingPaths.backups,
      reserveMiB,
      instanceId: paths.instanceId,
      build,
      now: () => new Date().toISOString(),
      newSnapshotId: randomUUID,
    }),
  now: () => new Date().toISOString(),
  newOperationId: randomUUID,
});
if (!database.ok) {
  bootstrapFailed(database.code, database.fields);
}
console.log(
  JSON.stringify({
    event: "bootstrap.ready",
    installMode: environment.installMode,
    baseUrl: environment.baseUrl,
    updaterEnabled: environment.updater.enabled,
    instanceId: paths.instanceId,
    hostPlatform: paths.hostPlatform,
    databasePath: workingPaths.database,
    containerDatabasePath: paths.container.database,
    degraded: preflight.degraded,
    maintenance: { generation: gate.gate.current().generation, initialized: gate.initialized },
    database: { schemaVersion: database.schemaVersion, created: database.created },
    settings: settings.map(({ key, value, source }) => ({ key, value, source })),
  }),
);

const app = createApp({ webRoot, indexHtml, newRequestId: randomUUID });
try {
  const { server, address } = await startServer(app, host, port);
  // After HTTP the database closes, and the lease goes last (§15.2).
  stopOnSignals(server, SHUTDOWN_TIMEOUT_MS, () => {
    database.connection.close();
    writer.lease.release();
  });
  console.log(JSON.stringify({ event: "server.listening", host: address.address, port: address.port }));
} catch (error) {
  fail(`cannot listen on ${host}:${port} (${error instanceof Error && "code" in error ? String(error.code) : "unknown error"})`);
}
