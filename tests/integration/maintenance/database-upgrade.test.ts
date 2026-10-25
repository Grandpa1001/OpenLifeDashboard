// D05.2 — upgrade of an existing database by the "next image" (harness plans B → C) on real
// installations: lease → gate → verified pre_migration snapshot of the old version → all pending
// migrations in one transaction → check → closed operation.
// AC1: the order is observable from the files: the snapshot holds version 2 while the database
//      ends at version 3, with identical domain rows and an extended manifest; a writer killed
//      inside the migration leaves the old schema, the published snapshot and the phase.
// AC2: a failed snapshot, a failing migration and an orphan row left by a migration all keep the
//      database at its version with its data; the snapshot of the old version stays restorable.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { verifyDatabaseSnapshot } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { inspectDatabase } from "../../../packages/sqlite/dist/migrations/public.js";
import { PLAN_B, PLAN_C } from "../../support/migration-plans.ts";
import { freshTestInstance, outputEvent, repoRoot, runServerEntry, waitForExit } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const NOTES = 25;
const BUSY_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 15_000;
const HOLDER_TIMEOUT_MS = 60_000;
const DATABASE_HOLDER = path.join(repoRoot, "tests/support/database-holder.ts");
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-upgrade-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const databaseFile = (instance: TestInstance): string => path.join(instance.dir, "data", "app.db");
const stateFile = (instance: TestInstance): string => path.join(instance.dir, "control", "maintenance", "state.json");
const backupsDir = (instance: TestInstance): string => path.join(instance.dir, "data", "backup");
const readState = (instance: TestInstance): { generation: number; activeOperation: Record<string, unknown> | null } => JSON.parse(readFileSync(stateFile(instance), "utf8"));
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const inspectAs = (instance: TestInstance, plan: typeof PLAN_B) => inspectDatabase(databaseFile(instance), plan, { instanceId: instance.instanceId, busyTimeoutMs: BUSY_TIMEOUT_MS });

/** Published snapshot packages (not the staging folder), oldest first. */
const packages = (instance: TestInstance): string[] =>
  readdirSync(backupsDir(instance)).filter((name) => !name.startsWith(".")).sort().map((name) => path.join(backupsDir(instance), name));

function query(file: string, sql: string): unknown[] {
  const reader = openDatabase(file, { role: "reader", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    return reader.handle.prepare(sql).all();
  } finally {
    reader.close();
  }
}

/** A standalone copy of a snapshot's database file, opened the way a restore would use it. */
function restoredRows(pkg: string, sql: string): unknown[] {
  const dir = mkdtempSync(path.join(scratch, "restored-"));
  const file = path.join(dir, "app.db");
  copyFileSync(path.join(pkg, "app.db"), file);
  const writer = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    expect(writer.handle.pragma("integrity_check", { simple: true })).toBe("ok");
    return writer.handle.prepare(sql).all();
  } finally {
    writer.close();
  }
}

function spawnHolder(instance: TestInstance, plan: string) {
  const child = spawn(process.execPath, [DATABASE_HOLDER, instance.dir, plan], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return { child, output: () => output };
}

async function runHolder(instance: TestInstance, plan: string): Promise<Record<string, unknown> | undefined> {
  const holder = spawnHolder(instance, plan);
  const exit = await waitForExit(holder.child, holder.output, HOLDER_TIMEOUT_MS);
  return outputEvent(exit.output, "database.opened") ?? outputEvent(exit.output, "database.refused");
}

/** An installation whose database is at plan B (version 2) with notes in a domain table. */
async function installationAtB(): Promise<TestInstance> {
  const instance = freshTestInstance();
  expect(await runHolder(instance, "b")).toEqual({ event: "database.opened", schemaVersion: 2, created: true });
  const writer = openDatabase(databaseFile(instance), { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  const insert = writer.handle.prepare("INSERT INTO harness_note (text) VALUES (?)");
  writer.handle.transaction(() => {
    for (let index = 0; index < NOTES; index += 1) insert.run(`note ${index}`);
  })();
  writer.close();
  return instance;
}

const noteSummary = "SELECT count(*) AS count, sum(id) AS ids, min(text) AS first, max(text) AS last FROM harness_note";
const tableNames = (file: string): unknown[] => query(file, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'harness%' ORDER BY name");
const noteColumns = (file: string): unknown[] => query(file, "SELECT name FROM pragma_table_info('harness_note') ORDER BY cid");
const manifestIds = (file: string): unknown[] => query(file, "SELECT id FROM schema_migration ORDER BY version");

describe("D05.2-AC1 upgrade after a verified snapshot", () => {
  it("snapshot of version 2, database at version 3, same domain rows, extended manifest, closed operation", async () => {
    const instance = await installationAtB();
    const before = query(databaseFile(instance), noteSummary);
    expect(before).toEqual([{ count: NOTES, ids: (NOTES * (NOTES + 1)) / 2, first: "note 0", last: "note 9" }]);
    expect(readState(instance)).toMatchObject({ generation: 1, activeOperation: null });

    expect(await runHolder(instance, "c")).toEqual({ event: "database.opened", schemaVersion: 3, created: false });

    // The database: manifest of plan C, the same notes with the new column, the new table.
    expect(manifestIds(databaseFile(instance))).toEqual(PLAN_C.map((migration) => ({ id: migration.id })));
    expect(query(databaseFile(instance), noteSummary)).toEqual(before);
    expect(noteColumns(databaseFile(instance))).toEqual([{ name: "id" }, { name: "text" }, { name: "done" }]);
    expect(query(databaseFile(instance), "SELECT count(*) AS count FROM harness_note WHERE done = 0")).toEqual([{ count: NOTES }]);
    expect(tableNames(databaseFile(instance))).toEqual([{ name: "harness_extra" }, { name: "harness_note" }]);
    expect(query(databaseFile(instance), "SELECT instance_id FROM instance")).toEqual([{ instance_id: instance.instanceId }]);
    expect(inspectAs(instance, PLAN_C)).toEqual({ kind: "current", schemaVersion: 3 });
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });

    // The snapshot taken first: verified, version 2, without anything of the migration.
    const [pkg, ...others] = packages(instance);
    expect(others).toEqual([]);
    expect(pkg).toBeDefined();
    const verification = verifyDatabaseSnapshot(pkg ?? "");
    expect(verification).toEqual({ ok: true, meta: expect.objectContaining({ reason: "pre_migration", schemaVersion: 2, instanceId: instance.instanceId }) });
    expect(restoredRows(pkg ?? "", "SELECT id FROM schema_migration ORDER BY version")).toEqual(PLAN_B.map((migration) => ({ id: migration.id })));
    expect(restoredRows(pkg ?? "", noteSummary)).toEqual(before);
    expect(restoredRows(pkg ?? "", "SELECT name FROM pragma_table_info('harness_note') ORDER BY cid")).toEqual([{ name: "id" }, { name: "text" }]);
    expect(restoredRows(pkg ?? "", "SELECT name FROM sqlite_schema WHERE name = 'harness_extra'")).toEqual([]);
    expect(existsSync(path.join(backupsDir(instance), ".staging")) ? readdirSync(path.join(backupsDir(instance), ".staging")) : []).toEqual([]);
  });

  it("a restart of the same image after the upgrade changes nothing and takes no second snapshot", async () => {
    const instance = await installationAtB();
    await runHolder(instance, "c");
    expect(await runHolder(instance, "c")).toEqual({ event: "database.opened", schemaVersion: 3, created: false });
    expect(packages(instance)).toHaveLength(1);
    expect(readState(instance).generation).toBe(2);
    expect(inspectAs(instance, PLAN_C)).toEqual({ kind: "current", schemaVersion: 3 });
  });

  it("a writer killed inside the migration leaves version 2, the snapshot and the phase; start needs recovery", async () => {
    const instance = await installationAtB();
    const holder = spawnHolder(instance, "c-slow");
    const deadline = Date.now() + HOLDER_TIMEOUT_MS;
    const migrating = (): boolean => existsSync(stateFile(instance)) && readState(instance).activeOperation?.["phase"] === "migrating";
    while (!(migrating() && packages(instance).length === 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(holder.child.exitCode, holder.output()).toBeNull();
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child, holder.output, STOP_TIMEOUT_MS);

    // Atomic: the unfinished transaction left nothing of version 3.
    expect(inspectAs(instance, PLAN_B)).toEqual({ kind: "current", schemaVersion: 2 });
    expect(tableNames(databaseFile(instance))).toEqual([{ name: "harness_note" }]);
    expect(query(databaseFile(instance), noteSummary)).toEqual([{ count: NOTES, ids: (NOTES * (NOTES + 1)) / 2, first: "note 0", last: "note 9" }]);
    const [pkg] = packages(instance);
    const verification = verifyDatabaseSnapshot(pkg ?? "");
    expect(verification.ok).toBe(true);
    expect(readState(instance)).toMatchObject({
      generation: 2,
      activeOperation: { reason: "migrate", phase: "migrating", fromSchemaVersion: 2, toSchemaVersion: 3, snapshotId: verification.ok ? verification.meta.snapshotId : "" },
    });
    // Reconciling a crash during migrate is D05.3: until then every start is refused.
    const exit = await runServerEntry(["--port", "0", "--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env });
    expect(exit.code).toBe(1);
    expect(outputEvent(exit.output, "bootstrap.failed")).toEqual({ event: "bootstrap.failed", code: "MAINTENANCE_RECOVERY_REQUIRED", fields: ["activeOperation"] });
  });
});

describe("D05.2-AC2 failures keep the database at its version", () => {
  async function expectUnchangedAtB(instance: TestInstance, before: unknown[]): Promise<void> {
    expect(inspectAs(instance, PLAN_B)).toEqual({ kind: "current", schemaVersion: 2 });
    expect(manifestIds(databaseFile(instance))).toEqual(PLAN_B.map((migration) => ({ id: migration.id })));
    expect(tableNames(databaseFile(instance))).toEqual([{ name: "harness_note" }]);
    expect(noteColumns(databaseFile(instance))).toEqual([{ name: "id" }, { name: "text" }]);
    expect(query(databaseFile(instance), noteSummary)).toEqual(before);
  }

  it("a snapshot that cannot be written stops the upgrade before any change; a later try succeeds", async () => {
    const instance = await installationAtB();
    const before = query(databaseFile(instance), noteSummary);
    const databaseBefore = sha256(databaseFile(instance));
    chmodSync(backupsDir(instance), 0o555);
    try {
      expect(await runHolder(instance, "c")).toEqual({ event: "database.refused", code: "MIGRATION_SNAPSHOT_REQUIRED", fields: ["schemaVersion"] });
    } finally {
      chmodSync(backupsDir(instance), 0o755);
    }
    await expectUnchangedAtB(instance, before);
    expect(sha256(databaseFile(instance))).toBe(databaseBefore);
    expect(packages(instance)).toEqual([]);
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });

    expect(await runHolder(instance, "c")).toEqual({ event: "database.opened", schemaVersion: 3, created: false });
    expect(packages(instance)).toHaveLength(1);
  });

  it("a failing third migration rolls back its ALTER and manifest entry; the snapshot of version 2 stays restorable", async () => {
    const instance = await installationAtB();
    const before = query(databaseFile(instance), noteSummary);
    expect(await runHolder(instance, "c-fails")).toEqual({ event: "database.refused", code: "MIGRATION_FAILED", fields: ["0003-harness-fails"] });

    await expectUnchangedAtB(instance, before);
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });
    const [pkg, ...others] = packages(instance);
    expect(others).toEqual([]);
    expect(verifyDatabaseSnapshot(pkg ?? "")).toMatchObject({ ok: true, meta: { reason: "pre_migration", schemaVersion: 2 } });
    expect(restoredRows(pkg ?? "", noteSummary)).toEqual(before);
    // The image that matches the database still starts it.
    expect(await runHolder(instance, "b")).toEqual({ event: "database.opened", schemaVersion: 2, created: false });
  });

  it("a migration that leaves an orphan row fails its check and is rolled back completely", async () => {
    const instance = await installationAtB();
    const before = query(databaseFile(instance), noteSummary);
    expect(await runHolder(instance, "c-orphan")).toEqual({ event: "database.refused", code: "MIGRATION_FAILED", fields: ["0003-harness-orphan"] });
    await expectUnchangedAtB(instance, before);
    expect(packages(instance)).toHaveLength(1);
  });
});
