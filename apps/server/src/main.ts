// Server process entrypoint: the only place that starts HTTP (Architektura §13.1).
// Bootstrap order (§4.8, §14.5, §18.6): start options → web app → environment → instance
// metadata → option set → storage preflight → writer lease → maintenance gate → database
// (inspect, initialize, upgrade with a snapshot or reconcile) → auth schema → MFA capabilities → technical logger → HTTP. Any failure exits 1 before listening; a failure
// names a code and fields, never a value. Exiting releases the lease with the process; nothing
// before the lease opens or changes database files.
import { getConnInfo } from "@hono/node-server/conninfo";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_MIGRATION_PLAN } from "@openlife/sqlite/migrations";
import { bindAppendAudit } from "@openlife/sqlite/adapters/audit";
import { bindOwnerWriters, bindSignInStores } from "@openlife/sqlite/adapters/identity";
import { createUnitOfWork } from "@openlife/sqlite/transactions";
import { createAttemptKeys } from "./adapters/auth/attempt-keys.js";
import { checkAuthSchema } from "./adapters/auth/auth-schema.js";
import { checkMfaIntegration } from "./adapters/auth/mfa-capabilities.js";
import { createPasswordHasher } from "./adapters/auth/password-hasher.js";
import { createSessionCookies } from "./adapters/auth/session-cookie.js";
import { CONTAINER_WORKING_PATHS, installationWorkingPaths } from "./adapters/filesystem/installation-paths.js";
import { createDatabaseSnapshots } from "./adapters/filesystem/database-snapshots.js";
import { openMaintenanceGate } from "./adapters/filesystem/maintenance-gate.js";
import { LOG_RETENTION_SWEEP_MS } from "./adapters/logging/limits.js";
import { createRotatingFileSink } from "./adapters/logging/rotating-file-sink.js";
import { stdoutSink } from "./adapters/logging/stdout-sink.js";
import { createTechnicalLogger } from "./adapters/logging/technical-logger.js";
import { runStoragePreflight } from "./adapters/filesystem/storage-preflight.js";
import { acquireWriterLease } from "./adapters/filesystem/writer-lease.js";
import { loadBootstrapConfig } from "./bootstrap/bootstrap-config.js";
import { createApp } from "./bootstrap/create-app.js";
import { createRateLimiter } from "./http/middleware/fixed-window-limit.js";
import { LOGIN_LIMIT_WINDOW_MS, LOGIN_REQUESTS_PER_MINUTE } from "./http/security-limits.js";
import { logLimitsFrom } from "./bootstrap/log-limits.js";
import { readBuildInfo } from "./bootstrap/build-info.js";
import { openInstallationDatabase } from "./bootstrap/database.js";
import { drainServer, startServer } from "./bootstrap/lifecycle.js";
import { createReadiness } from "./bootstrap/readiness.js";
import { createShutdown } from "./bootstrap/shutdown.js";
import { LOG_MIN_LEVEL, LOG_SERVICE, SHUTDOWN_TIMEOUT_MS } from "./bootstrap/runtime-defaults.js";
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
// The auth tables must match the pinned adapter before anything can be ready (§9.8).
const authSchema = checkAuthSchema(database.connection);
if (!authSchema.ok) {
  bootstrapFailed(authSchema.code, authSchema.fields);
}
// The second-factor libraries must behave as the design assumes before anything is ready (D10.1).
const mfaIntegration = await checkMfaIntegration();
if (!mfaIntegration.ok) {
  bootstrapFailed(mfaIntegration.code, mfaIntegration.fields);
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

// The technical log: stdout always and data/logs/app/app.jsonl, rotated within the logs.* limits.
// A file that cannot be written makes the sink degraded (reported on stderr, retried later), never
// a failed start or a failed request; the preflight has already reported an unusable folder.
const logFile = createRotatingFileSink({
  dir: workingPaths.logs,
  limits: logLimitsFrom(() => settings),
  now: () => new Date(),
  notify: (line) => process.stderr.write(line),
});
logFile.enforceRetention();
const retentionSweep = setInterval(logFile.enforceRetention, LOG_RETENTION_SWEEP_MS);
retentionSweep.unref();
const logger = createTechnicalLogger({
  identity: { service: LOG_SERVICE, appVersion: build.appVersion, instanceId: paths.instanceId },
  minLevel: LOG_MIN_LEVEL,
  now: () => new Date(),
  sinks: [stdoutSink, logFile],
});
const readiness = createReadiness();
// Sign-in composition (D09.3): the library supplies the schema and crypto, every write goes
// through the application's unit of work on the one writer connection (Architektura §9.8).
const hasher = createPasswordHasher();
const secret = environment.betterAuthSecret.reveal();
const app = createApp({
  webRoot,
  indexHtml,
  newRequestId: randomUUID,
  logger,
  readiness,
  nowMs: () => performance.now(),
  identity: {
    unit: createUnitOfWork(database.connection, (tx) => ({
      ...bindSignInStores(tx),
      owners: bindOwnerWriters(tx).owners,
      audit: bindAppendAudit(tx),
    })),
    verifier: hasher,
    // Verified for an unknown e-mail, so a refusal costs the same as for the owner's.
    decoyHash: await hasher.hash(randomBytes(32).toString("hex")),
    cookies: createSessionCookies({ instanceId: paths.instanceId, secret }),
    keys: createAttemptKeys(secret),
    allowedOrigin: environment.baseUrl,
    secureCookies: environment.baseUrl.startsWith("https:"),
    loginLimiter: createRateLimiter({ limit: LOGIN_REQUESTS_PER_MINUTE, windowMs: LOGIN_LIMIT_WINDOW_MS, nowMs: Date.now }),
    clientIp: (c) => getConnInfo(c).remote.address ?? "unknown",
    nowMs: Date.now,
    newId: randomUUID,
    newSessionToken: () => randomBytes(32).toString("base64url"),
    logger,
  },
});
try {
  const { server, address } = await startServer(app, host, port);
  // One ordered sequence (§15.2): readiness, started requests, logger, database, and the writer
  // lease last, under one deadline.
  const shutdown = createShutdown({
    steps: [
      { name: "readiness", run: () => readiness.withdraw() },
      { name: "http", run: () => drainServer(server) },
      {
        name: "logger",
        run: () => {
          clearInterval(retentionSweep);
          logFile.close();
        },
      },
      { name: "database", run: () => database.connection.close() },
      { name: "lease", run: () => writer.lease.release() },
    ],
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    report: (event, stream) => (stream === "stdout" ? console.log : console.error)(JSON.stringify(event)),
    exit: (code) => process.exit(code),
  });
  // `on`, not `once`: with a one-time listener the second signal would find none and take the
  // default action, killing the process in the middle of the orderly stop. The sequence ignores
  // every signal after the first.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  console.log(JSON.stringify({ event: "server.listening", host: address.address, port: address.port }));
} catch (error) {
  fail(`cannot listen on ${host}:${port} (${error instanceof Error && "code" in error ? String(error.code) : "unknown error"})`);
}
