// D05.1 — `database` snapshots through the SQLite Backup API on real files.
// AC1: rows committed but still only in the WAL are in the snapshot; the package restored to a
//      separate file has the same counts and revisions, integrity_check=ok and an empty
//      foreign_key_check; the source writer keeps working.
// AC2: a published package holds exactly app.db, meta.json and checksums.json (no export.json,
//      no -wal/-shm); a changed byte, changed meta, extra or missing file, broken integrity or
//      meta that disagrees with the copy make it invalid; a source with an orphan row, too little
//      space or another instance's database publish nothing.
import { copyFileSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, closeSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDatabaseSnapshots,
  SNAPSHOT_STAGING_DIR,
  verifyDatabaseSnapshot,
  type SnapshotStoreOptions,
} from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { openDatabase, type SqliteConnection } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, inspectDatabase, type MigrationPlan } from "../../../packages/sqlite/dist/migrations/public.js";
import { FK_PLAN, PLAN_B, VERSION } from "../../support/migration-plans.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-snapshots-"));
const open: SqliteConnection[] = [];
afterAll(() => {
  for (const connection of open) if (connection.handle.open) connection.close();
  rmSync(scratch, { recursive: true, force: true });
});

const INSTANCE_ID = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const BUSY_TIMEOUT_MS = 5000;
const ROWS = 25;
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

let counter = 0;
type Source = Readonly<{ dir: string; backups: string; writer: SqliteConnection; options: SnapshotStoreOptions }>;

/** A plan-initialized database (checkpointed on close) reopened as writer with WAL autocheckpoint off. */
function source(plan: MigrationPlan = PLAN_B, overrides: Partial<SnapshotStoreOptions> = {}): Source {
  const dir = path.join(scratch, `source-${(counter += 1)}`);
  const backups = path.join(dir, "backup");
  mkdirSync(backups, { recursive: true });
  const file = path.join(dir, "app.db");
  const init = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  initializeDatabase(init, plan, { instanceId: INSTANCE_ID, createdAt: new Date().toISOString() });
  init.close();
  const writer = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  writer.handle.pragma("wal_autocheckpoint = 0");
  open.push(writer);
  const options: SnapshotStoreOptions = {
    backupsDir: backups,
    reserveMiB: 1,
    instanceId: INSTANCE_ID,
    build: { appVersion: "0.0.0", buildRevision: "test-revision", imageDigest: null },
    now: () => new Date().toISOString(),
    newSnapshotId: randomUUID,
    ...overrides,
  };
  return { dir, backups, writer, options };
}

function insertNotes(writer: SqliteConnection, count: number): void {
  const insert = writer.handle.prepare("INSERT INTO harness_note (text) VALUES (?)");
  writer.handle.transaction(() => {
    for (let index = 0; index < count; index += 1) insert.run(`note ${index}`);
  })();
}

const request = () => ({ reason: "pre_migration", scope: "database", operationId: randomUUID(), fence: 1 }) as const;

/** The published package directory of a snapshot. */
function packageDir(backups: string, snapshotId: string): string {
  const name = readdirSync(backups).find((entry) => entry.endsWith(snapshotId));
  if (!name) throw new Error(`no package for ${snapshotId} in ${readdirSync(backups).join(", ")}`);
  return path.join(backups, name);
}

async function snapshot(src: Source): Promise<string> {
  const result = await createDatabaseSnapshots(src.writer, src.options).create(request());
  if (!result.ok) throw new Error(result.code);
  return packageDir(src.backups, result.snapshotId);
}

function count(file: string, sql: string): unknown {
  const reader = openDatabase(file, { role: "reader", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    return reader.handle.prepare(sql).pluck().get();
  } finally {
    reader.close();
  }
}

/** Copies the package's app.db to its own folder, as a restore places it, and opens it as writer. */
function restore(pkg: string): SqliteConnection {
  const dir = path.join(scratch, `restored-${(counter += 1)}`);
  mkdirSync(dir);
  const file = path.join(dir, "app.db");
  copyFileSync(path.join(pkg, "app.db"), file);
  const writer = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  open.push(writer);
  return writer;
}

/** Rewrites checksums.json after a deliberate change, so only the later checks can object. */
function rewriteChecksums(pkg: string): void {
  const checksums = { algorithm: "sha256", files: { "app.db": sha256(path.join(pkg, "app.db")), "meta.json": sha256(path.join(pkg, "meta.json")) } };
  writeFileSync(path.join(pkg, "checksums.json"), JSON.stringify(checksums));
}

describe("D05.1-AC1 committed WAL content in a restorable snapshot", () => {
  it("rows only in the WAL are in the snapshot; the restored copy matches counts and checks", async () => {
    const src = source();
    insertNotes(src.writer, ROWS);
    const databaseFile = path.join(src.dir, "app.db");
    expect(statSync(`${databaseFile}-wal`).size).toBeGreaterThan(0);
    // A plain copy of the main file alone misses them: the content is really only in the WAL.
    const naive = path.join(src.dir, "naive.db");
    copyFileSync(databaseFile, naive);
    expect(count(naive, "SELECT count(*) FROM harness_note")).toBe(0);

    const pkg = await snapshot(src);
    const restored = restore(pkg);
    expect(restored.handle.prepare("SELECT count(*), sum(id) FROM harness_note").raw().get()).toEqual([ROWS, (ROWS * (ROWS + 1)) / 2]);
    expect(restored.handle.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(restored.handle.pragma("foreign_key_check")).toEqual([]);
    restored.close();
    expect(inspectDatabase(restored.handle.name, PLAN_B, { instanceId: INSTANCE_ID, busyTimeoutMs: BUSY_TIMEOUT_MS })).toEqual({ kind: "current", schemaVersion: VERSION.b });

    // The source writer keeps working; a later row is not in the earlier snapshot.
    insertNotes(src.writer, 1);
    expect(src.writer.handle.prepare("SELECT count(*) FROM harness_note").pluck().get()).toBe(ROWS + 1);
    expect(restore(pkg).handle.prepare("SELECT count(*) FROM harness_note").pluck().get()).toBe(ROWS);
  });
});

describe("D05.1-AC2 package contents and verification", () => {
  it("a published package has exactly app.db, meta.json and checksums.json and verifies", async () => {
    const src = source();
    insertNotes(src.writer, 3);
    const req = request();
    const result = await createDatabaseSnapshots(src.writer, src.options).create(req);
    if (!result.ok) throw new Error(result.code);
    const pkg = packageDir(src.backups, result.snapshotId);
    expect(readdirSync(pkg).sort()).toEqual(["app.db", "checksums.json", "meta.json"]);
    expect(readdirSync(path.join(src.backups, SNAPSHOT_STAGING_DIR))).toEqual([]);
    const verification = verifyDatabaseSnapshot(pkg);
    expect(verification).toEqual({
      ok: true,
      meta: expect.objectContaining({
        scope: "database",
        snapshotId: result.snapshotId,
        operationId: req.operationId,
        instanceId: INSTANCE_ID,
        reason: "pre_migration",
        schemaVersion: VERSION.b,
        buildRevision: "test-revision",
        imageDigest: null,
        databaseBytes: statSync(path.join(pkg, "app.db")).size,
        requiresOriginalKeys: true,
      }),
    });
    expect(Object.keys(verification.ok ? verification.meta : {})).not.toContain("formatVersion");
  });

  const corruptions: ReadonlyArray<readonly [string, (pkg: string) => void, string[]]> = [
    [
      "a changed byte of app.db",
      (pkg) => {
        const fd = openSync(path.join(pkg, "app.db"), "r+");
        writeSync(fd, Buffer.from("X"), 0, 1, 200);
        closeSync(fd);
      },
      ["app.db"],
    ],
    ["changed meta", (pkg) => writeFileSync(path.join(pkg, "meta.json"), readFileSync(path.join(pkg, "meta.json"), "utf8").replace("pre_migration", "nightly")), ["meta.json"]],
    ["an extra -wal file", (pkg) => writeFileSync(path.join(pkg, "app.db-wal"), ""), ["files"]],
    ["a missing checksums file", (pkg) => rmSync(path.join(pkg, "checksums.json")), ["files"]],
    [
      "a damaged page with checksums rewritten",
      (pkg) => {
        const fd = openSync(path.join(pkg, "app.db"), "r+");
        writeSync(fd, Buffer.alloc(512, 0xa5), 0, 512, 4096 + 8);
        closeSync(fd);
        rewriteChecksums(pkg);
      },
      ["integrity"],
    ],
    [
      "meta that disagrees with the copy, checksums rewritten",
      (pkg) => {
        const meta = JSON.parse(readFileSync(path.join(pkg, "meta.json"), "utf8"));
        writeFileSync(path.join(pkg, "meta.json"), JSON.stringify({ ...meta, schemaVersion: VERSION.a }));
        rewriteChecksums(pkg);
      },
      ["schemaVersion"],
    ],
  ];

  it.each(corruptions)("%s makes the package invalid", async (_name, corrupt, fields) => {
    const src = source();
    insertNotes(src.writer, 3);
    const pkg = await snapshot(src);
    corrupt(pkg);
    expect(verifyDatabaseSnapshot(pkg)).toEqual({ ok: false, code: "SNAPSHOT_INVALID", fields });
  });

  it("a source with an orphan row publishes nothing and leaves no staging", async () => {
    const src = source(FK_PLAN);
    src.writer.handle.pragma("foreign_keys = OFF");
    src.writer.handle.exec("INSERT INTO harness_child (id, parent_id) VALUES (1, 42)");
    src.writer.handle.pragma("foreign_keys = ON");
    expect(await createDatabaseSnapshots(src.writer, src.options).create(request())).toEqual({ ok: false, code: "SNAPSHOT_FAILED" });
    expect(readdirSync(src.backups)).toEqual([SNAPSHOT_STAGING_DIR]);
    expect(readdirSync(path.join(src.backups, SNAPSHOT_STAGING_DIR))).toEqual([]);
  });

  it("too little space for the copy plus the reserve publishes nothing", async () => {
    const src = source(PLAN_B, { reserveMiB: 1024 * 1024 * 1024 });
    expect(await createDatabaseSnapshots(src.writer, src.options).create(request())).toEqual({ ok: false, code: "SNAPSHOT_LOW_SPACE" });
    expect(readdirSync(src.backups)).toEqual([]);
  });

  it("a missing backup folder is a failed snapshot, not an exception", async () => {
    const src = source();
    rmSync(src.backups, { recursive: true });
    expect(await createDatabaseSnapshots(src.writer, src.options).create(request())).toEqual({ ok: false, code: "SNAPSHOT_FAILED" });
  });

  it("a source database of another instance publishes nothing", async () => {
    const src = source(PLAN_B, { instanceId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" });
    expect(await createDatabaseSnapshots(src.writer, src.options).create(request())).toEqual({ ok: false, code: "SNAPSHOT_FAILED" });
    expect(readdirSync(path.join(src.backups, SNAPSHOT_STAGING_DIR))).toEqual([]);
  });
});
