// Runs INSIDE the app image (tests/system/container-snapshot-space.ts) or, for development, on a
// host against apps/server/dist with --data/--backups/--dist (DEV D05.3-AC2). The backup folder
// is a size-limited file system. The script leaves exactly the size of one database copy free
// there, so the free-space check passes and the real write then runs out of space (ENOSPC):
//   0. the file system is shown to be limited: writing past its free space fails with ENOSPC;
//   1. a database with ballast is initialized through the bootstrap step (plan A);
//   2. a good snapshot is published, then the file system is filled up to one copy;
//   3. the upgrade to plan B must stop with MIGRATION_SNAPSHOT_REQUIRED, publish nothing, leave
//      the database, the gate and the good snapshot untouched and clean its staging;
//   4. after space is freed the same upgrade succeeds.
// Prints one JSON object with the observations; exits 1 on an unexpected exception.
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import console from "node:console";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const data = args.get("--data") ?? "/data";
const backups = args.get("--backups") ?? "/backup-small";
const dist = args.get("--dist") ?? "/app/apps/server/dist";
const BALLAST_ROWS = 3;
const MIB = 1024 * 1024;

const fromDist = (relative) => import(pathToFileURL(path.join(dist, relative)).href);
const requireFromServer = createRequire(path.join(dist, "main.js"));
const fromPackage = (name) => import(pathToFileURL(requireFromServer.resolve(name)).href);

const { acquireWriterLease } = await fromDist("adapters/filesystem/writer-lease.js");
const { openMaintenanceGate } = await fromDist("adapters/filesystem/maintenance-gate.js");
const { createDatabaseSnapshots, verifyDatabaseSnapshot } = await fromDist("adapters/filesystem/database-snapshots.js");
const { openInstallationDatabase } = await fromDist("bootstrap/database.js");
const { inspectDatabase, PRODUCT_MIGRATION_PLAN, sqlChecksum } = await fromPackage("@openlife/sqlite/migrations");
const { openDatabase } = await fromPackage("@openlife/sqlite/connection");

const maintenance = path.join(data, "maint");
const databaseFile = path.join(data, "work", "app.db");
mkdirSync(maintenance, { recursive: true });
mkdirSync(path.dirname(databaseFile), { recursive: true });

const instanceId = randomUUID();
const sql = "CREATE TABLE space_probe_added (id INTEGER PRIMARY KEY) STRICT;\n";
const planA = PRODUCT_MIGRATION_PLAN;
const planB = [...planA, { version: 2, id: "0002-space-probe", sql, checksum: sqlChecksum(sql) }];
const now = () => new Date().toISOString();

const lease = acquireWriterLease(maintenance);
if (!lease.ok) throw new Error(`no writer lease: ${lease.code}`);
const gate = openMaintenanceGate(lease.lease, { maintenance, database: databaseFile });
if (!gate.ok) throw new Error(`no gate: ${gate.code}`);

const snapshotsFor = (source) =>
  createDatabaseSnapshots(source, {
    backupsDir: backups,
    reserveMiB: 0,
    instanceId,
    build: { appVersion: "0.0.0-space", buildRevision: "space", imageDigest: null },
    now,
    newSnapshotId: randomUUID,
  });
const open = (plan) =>
  openInstallationDatabase({ file: databaseFile, gate: gate.gate, plan, instanceId, busyTimeoutMs: 5000, createSnapshots: snapshotsFor, now, newOperationId: randomUUID });

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const free = () => {
  const stats = statfsSync(backups);
  return { blocks: stats.bavail, blockSize: stats.bsize, bytes: stats.bavail * stats.bsize };
};
const published = () => readdirSync(backups).filter((name) => !name.startsWith(".")).sort().map((name) => path.join(backups, name));
const packageHashes = (dir) => readdirSync(dir).sort().map((name) => sha256(path.join(dir, name)));
const staging = () => {
  try {
    return readdirSync(path.join(backups, ".staging"));
  } catch {
    return [];
  }
};

// The file system really is limited: one more page than the free space cannot be written. Done
// first, on the empty file system, so that everything measured afterwards is measured after it.
const limit = free();
const probe = path.join(backups, ".probe");
let probeCode = "none";
const probeFd = openSync(probe, "wx");
try {
  // A write that hits the end of the space may return a short count (Linux) instead of failing;
  // the error comes with the next call that makes no progress, so write until it does.
  for (let written = 0; written < limit.bytes + limit.blockSize; ) {
    written += writeSync(probeFd, Buffer.alloc(Math.min(MIB, limit.bytes + limit.blockSize - written)));
  }
} catch (error) {
  probeCode = error instanceof Error && "code" in error ? String(error.code) : "unknown";
} finally {
  closeSync(probeFd);
  rmSync(probe, { force: true });
}

// 1. A database with ballast, checkpointed so that no WAL counts towards the copy.
const created = await open(planA);
if (!created.ok) throw new Error(`init failed: ${created.code}`);
created.connection.handle.exec("CREATE TABLE ballast (id INTEGER PRIMARY KEY, data BLOB NOT NULL)");
for (let row = 0; row < BALLAST_ROWS; row += 1) created.connection.handle.prepare("INSERT INTO ballast (data) VALUES (zeroblob(?))").run(MIB);
created.connection.handle.pragma("wal_checkpoint(TRUNCATE)");

// 2. A good snapshot, then fill the file system up to exactly one more copy.
const good = await snapshotsFor(created.connection).create({ reason: "pre_migration", scope: "database", operationId: randomUUID(), fence: 1 });
if (!good.ok) throw new Error(`the first snapshot failed: ${good.code}`);
created.connection.close();
const databaseBytes = statSync(databaseFile).size;
const [goodPackage] = published();
const goodHashes = packageHashes(goodPackage);
const before = free();
const copyBlocks = Math.ceil(databaseBytes / before.blockSize);
const fillBytes = (before.blocks - copyBlocks) * before.blockSize;
if (fillBytes <= 0) throw new Error("the backup file system is too small for the ballast");
const filler = path.join(backups, ".filler");
const fillFd = openSync(filler, "wx");
for (let written = 0; written < fillBytes; ) {
  written += writeSync(fillFd, Buffer.alloc(Math.min(MIB, fillBytes - written)));
}
closeSync(fillFd);
const afterFill = free();

// 3. The snapshot passes the free-space check, the copy fills the file system, a later write fails.
// Called directly first: SNAPSHOT_FAILED (not SNAPSHOT_LOW_SPACE) proves the error was the real
// write error, since the bootstrap maps both to the same refusal.
const source = openDatabase(databaseFile, { role: "writer", busyTimeoutMs: 5000 });
const direct = await snapshotsFor(source).create({ reason: "pre_migration", scope: "database", operationId: randomUUID(), fence: 1 });
source.close();
const directObservation = { result: direct.ok ? { ok: true } : { ok: false, code: direct.code }, staging: staging(), freeBytes: free().bytes };
const refused = await open(planB);
const afterRefusal = {
  result: refused.ok ? { ok: true } : { ok: false, code: refused.code, fields: refused.fields },
  published: published().map((dir) => path.basename(dir)),
  goodUntouched: JSON.stringify(packageHashes(goodPackage)) === JSON.stringify(goodHashes) && verifyDatabaseSnapshot(goodPackage).ok,
  staging: staging(),
  freeBytes: free().bytes,
  gateActiveOperation: gate.gate.current().activeOperation,
  inspection: inspectDatabase(databaseFile, planA, { instanceId, busyTimeoutMs: 5000 }),
};

// 4. With space again the same upgrade succeeds.
rmSync(filler);
const retried = await open(planB);
if (retried.ok) retried.connection.close();
const result = {
  databaseBytes,
  freeBeforeFill: before.bytes,
  freeAfterFill: afterFill.bytes,
  probeCode,
  limitBytes: limit.bytes,
  direct: directObservation,
  afterRefusal,
  retry: retried.ok ? { ok: true, schemaVersion: retried.schemaVersion } : { ok: false, code: retried.code },
  publishedAfterRetry: published().length,
  goodStillVerifies: verifyDatabaseSnapshot(goodPackage).ok,
};
lease.lease.release();
console.log(JSON.stringify(result));
