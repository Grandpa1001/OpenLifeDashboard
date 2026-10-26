// D04.3 — the database step of the real server bootstrap and of harness writers on real
// installations (writer lease, maintenance gate, file database).
// AC1: a new installation initializes once and two restarts keep its manifest, identity and
//      gate generation; an init killed inside its transaction leaves no table and the next start
//      initializes under the same operation; an init committed before its operation was closed
//      is closed by the next start.
// AC2: a pending upgrade without a snapshot, a changed checksum, a newer schema, a foreign file,
//      another instance's database and a missing database stop the start with exit 1 and leave
//      the database file unchanged.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { inspectDatabase } from "../../../packages/sqlite/dist/migrations/public.js";
import { PLAN_A, PLAN_B, SLOW_PLAN, VERSION } from "../../support/migration-plans.ts";
import {
  freshTestInstance,
  outputEvent,
  repoRoot,
  runServerEntry,
  startBuiltServer,
  startWriterHolder,
  waitForExit,
} from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const STOP_TIMEOUT_MS = 15_000;
/** The slow harness plan computes for seconds inside its transaction; allow for slow runners. */
const HOLDER_TIMEOUT_MS = 60_000;
const DATABASE_HOLDER = path.join(repoRoot, "tests/support/database-holder.ts");

const processEnv = (instance: TestInstance) => ({ PATH: process.env["PATH"] ?? "", ...instance.env });
const databaseFile = (instance: TestInstance): string => path.join(instance.dir, "data", "app.db");
const stateFile = (instance: TestInstance): string => path.join(instance.dir, "control", "maintenance", "state.json");
const readState = (instance: TestInstance): unknown => JSON.parse(readFileSync(stateFile(instance), "utf8"));
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function readRows(instance: TestInstance, sql: string): unknown[] {
  const reader = openDatabase(databaseFile(instance), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return reader.handle.prepare(sql).all();
  } finally {
    reader.close();
  }
}

function writeSql(instance: TestInstance, sql: string): void {
  const writer = openDatabase(databaseFile(instance), { role: "writer", busyTimeoutMs: 5000 });
  writer.handle.exec(sql);
  writer.close();
}

/** Starts and stops the built server; returns the `database` part of its ready event. */
async function bootReady(instance: TestInstance): Promise<unknown> {
  const server = await startBuiltServer({ installation: instance });
  server.child.kill("SIGTERM");
  const exit = await waitForExit(server.child, server.output, STOP_TIMEOUT_MS);
  expect(exit.code, exit.output).toBe(0);
  return outputEvent(exit.output, "bootstrap.ready")?.["database"];
}

async function bootRefused(instance: TestInstance): Promise<unknown> {
  const exit = await runServerEntry(["--port", "0", "--installation", instance.dir], processEnv(instance));
  expect(exit.code, exit.output).toBe(1);
  expect(exit.output).not.toContain('"server.listening"');
  return outputEvent(exit.output, "bootstrap.failed");
}

function spawnDatabaseHolder(instance: TestInstance, plan: string) {
  const child = spawn(process.execPath, [DATABASE_HOLDER, instance.dir, plan], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return { child, output: () => output };
}

async function runDatabaseHolder(instance: TestInstance, plan: string): Promise<Record<string, unknown> | undefined> {
  const holder = spawnDatabaseHolder(instance, plan);
  const exit = await waitForExit(holder.child, holder.output, HOLDER_TIMEOUT_MS);
  return outputEvent(exit.output, "database.opened") ?? outputEvent(exit.output, "database.refused");
}

const failed = (code: string, fields: string[]) => ({ event: "bootstrap.failed", code, fields });

describe("D04.3-AC1 initialization and restarts", () => {
  it("a new installation initializes once; two restarts keep manifest, identity and generation", async () => {
    const instance = freshTestInstance();
    expect(await bootReady(instance)).toEqual({ schemaVersion: VERSION.a, created: true });
    const manifest = readRows(instance, "SELECT version, id, checksum, applied_at FROM schema_migration");
    const identity = readRows(instance, "SELECT instance_id, created_at FROM instance");
    expect(manifest).toHaveLength(PLAN_A.length);
    expect(identity).toEqual([{ instance_id: instance.instanceId, created_at: expect.any(String) }]);

    for (let restart = 0; restart < 2; restart += 1) {
      expect(await bootReady(instance)).toEqual({ schemaVersion: VERSION.a, created: false });
      expect(readRows(instance, "SELECT version, id, checksum, applied_at FROM schema_migration")).toEqual(manifest);
      expect(readRows(instance, "SELECT instance_id, created_at FROM instance")).toEqual(identity);
      expect(readState(instance)).toEqual({ formatVersion: 1, generation: 1, activeOperation: null });
    }
  });

  it("an init killed inside its transaction leaves no table; the next start initializes under the same operation", async () => {
    const instance = freshTestInstance();
    const holder = spawnDatabaseHolder(instance, "slow");
    // The init operation is persisted before the writer opens; then its transaction runs for seconds.
    const deadline = Date.now() + HOLDER_TIMEOUT_MS;
    const initActive = (): boolean => existsSync(stateFile(instance)) && JSON.stringify(readState(instance)).includes('"reason":"init"');
    while (!(initActive() && existsSync(databaseFile(instance))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(holder.child.exitCode, holder.output()).toBeNull();
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child, holder.output, STOP_TIMEOUT_MS);

    const interrupted = readState(instance);
    expect(interrupted).toMatchObject({ generation: 1, activeOperation: { reason: "init", targetSchemaVersion: VERSION.b } });
    expect(inspectDatabase(databaseFile(instance), SLOW_PLAN, { instanceId: instance.instanceId, busyTimeoutMs: 5000 })).toEqual({ kind: "empty" });

    expect(await runDatabaseHolder(instance, "slow")).toEqual({ event: "database.opened", schemaVersion: VERSION.b, created: true });
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 1, activeOperation: null });
    expect(readRows(instance, "SELECT id FROM schema_migration ORDER BY version")).toEqual(SLOW_PLAN.map((migration) => ({ id: migration.id })));
  });

  it("an init committed before its operation was closed is closed by the next start", async () => {
    const instance = freshTestInstance();
    await bootReady(instance);
    const databaseBefore = sha256(databaseFile(instance));
    const holder = await startWriterHolder(instance.dir, ["--begin", "init"]);
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child, () => "", STOP_TIMEOUT_MS);
    expect(readState(instance)).toMatchObject({ generation: 2, activeOperation: { reason: "init" } });

    expect(await bootReady(instance)).toEqual({ schemaVersion: VERSION.a, created: false });
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });
    expect(sha256(databaseFile(instance))).toBe(databaseBefore);
  });

  it("an interrupted init next to a database in any other state requires recovery", async () => {
    const instance = freshTestInstance();
    await bootReady(instance);
    const holder = await startWriterHolder(instance.dir, ["--begin", "init"]);
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child, () => "", STOP_TIMEOUT_MS);
    writeSql(instance, `UPDATE schema_migration SET checksum = '${"0".repeat(64)}'`);
    const before = [sha256(databaseFile(instance)), sha256(stateFile(instance))];
    expect(await bootRefused(instance)).toEqual(failed("MAINTENANCE_RECOVERY_REQUIRED", ["activeOperation"]));
    expect([sha256(databaseFile(instance)), sha256(stateFile(instance))]).toEqual(before);
  });
});

describe("D04.3-AC2 refused databases stay unchanged", () => {
  /** An initialized installation whose database the case then replaces or tampers with. */
  async function initializedInstance(): Promise<TestInstance> {
    const instance = freshTestInstance();
    await bootReady(instance);
    return instance;
  }

  function replaceDatabase(instance: TestInstance, write: (file: string) => void): void {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databaseFile(instance)}${suffix}`, { force: true });
    write(databaseFile(instance));
  }

  async function expectRefusedUnchanged(instance: TestInstance, failure: unknown): Promise<void> {
    const before = [sha256(databaseFile(instance)), sha256(stateFile(instance))];
    expect(await bootRefused(instance)).toEqual(failure);
    expect([sha256(databaseFile(instance)), sha256(stateFile(instance))]).toEqual(before);
  }

  it("a pending upgrade whose snapshot cannot be written is refused and the database stays at its version", async () => {
    const instance = await initializedInstance();
    const backups = path.join(instance.dir, "data", "backup");
    chmodSync(backups, 0o555);
    const before = sha256(databaseFile(instance));
    try {
      expect(await runDatabaseHolder(instance, "b")).toEqual({ event: "database.refused", code: "MIGRATION_SNAPSHOT_REQUIRED", fields: ["schemaVersion"] });
    } finally {
      chmodSync(backups, 0o755);
    }
    expect(sha256(databaseFile(instance))).toBe(before);
    expect(readRows(instance, "SELECT id FROM schema_migration ORDER BY version")).toEqual(PLAN_A.map((migration) => ({ id: migration.id })));
    expect(readRows(instance, "SELECT name FROM sqlite_schema WHERE name = 'harness_note'")).toEqual([]);
    // The refused migrate operation was recorded and closed; the image of plan A still starts.
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });
    expect(await bootReady(instance)).toEqual({ schemaVersion: VERSION.a, created: false });
  });

  it("a changed checksum of an applied migration → MIGRATION_CHECKSUM_MISMATCH", async () => {
    const instance = await initializedInstance();
    writeSql(instance, `UPDATE schema_migration SET checksum = '${"0".repeat(64)}' WHERE version = 1`);
    await expectRefusedUnchanged(instance, failed("MIGRATION_CHECKSUM_MISMATCH", ["0001-foundation"]));
  });

  it("a database of a newer plan → DATABASE_NEWER", async () => {
    const instance = freshTestInstance();
    expect(await runDatabaseHolder(instance, "b")).toEqual({ event: "database.opened", schemaVersion: PLAN_B.length, created: true });
    await expectRefusedUnchanged(instance, failed("DATABASE_NEWER", ["schemaVersion"]));
  });

  it("another installation's database → INSTANCE_METADATA_INVALID [instanceId]", async () => {
    const instance = await initializedInstance();
    writeSql(instance, "UPDATE instance SET instance_id = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0'");
    await expectRefusedUnchanged(instance, failed("INSTANCE_METADATA_INVALID", ["instanceId"]));
  });

  it("a non-SQLite file in place of the database → DATABASE_UNRECOGNIZED", async () => {
    const instance = await initializedInstance();
    replaceDatabase(instance, (file) => writeFileSync(file, "somebody's notes\n"));
    await expectRefusedUnchanged(instance, failed("DATABASE_UNRECOGNIZED", ["database"]));
  });

  it("a foreign SQLite database with its own tables → DATABASE_UNRECOGNIZED", async () => {
    const instance = await initializedInstance();
    replaceDatabase(instance, (file) => {
      const foreign = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
      foreign.handle.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('keep me');");
      foreign.close();
    });
    await expectRefusedUnchanged(instance, failed("DATABASE_UNRECOGNIZED", ["database"]));
  });

  it("a missing database of an initialized installation → DATABASE_MISSING, nothing is created", async () => {
    const instance = await initializedInstance();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${databaseFile(instance)}${suffix}`, { force: true });
    const gateBefore = sha256(stateFile(instance));
    expect(await bootRefused(instance)).toEqual(failed("DATABASE_MISSING", ["database"]));
    expect(existsSync(databaseFile(instance))).toBe(false);
    expect(sha256(stateFile(instance))).toBe(gateBefore);
  });
});
