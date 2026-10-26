// D05.3 — reconciliation of an upgrade that a crash interrupted, and snapshot failures on a real
// file system. Real SIGKILLs at chosen moments of the snapshot (tests/support/database-holder.ts
// --freeze) leave what a crash would; the next start with the matching image reconciles.
// AC1: a crash before publication leaves staging but no snapshot that counts as completed, and
//      the next start continues the SAME operation with a fresh snapshot; a crash after
//      publication leaves a finished snapshot that the next start recognizes by its operation and
//      verifies again, without a second one; a crash inside the migration resumes the same way; a
//      migration that committed before the operation was closed only closes it; a published
//      package that no longer verifies is not reused.
// AC2: a snapshot that fails on a real write error (EACCES when publishing) is not completed,
//      blocks the migration, leaves the database and the last good snapshot untouched and is
//      retried successfully. The out-of-space case runs on a size-limited file system in a
//      container (tests/system/container-snapshot-space.ts).
import { chmodSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, closeSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyDatabaseSnapshot } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { PLAN_B, PLAN_C, PLAN_D, SLOW_C_PLAN, VERSION } from "../../support/migration-plans.ts";
import {
  backupsDir,
  databaseFile,
  expectedNoteSummary,
  HOLDER_TIMEOUT_MS,
  crashHolderAt,
  inspectAs,
  installationAtB,
  manifestIds,
  noteColumns,
  noteSummary,
  packages,
  query,
  readState,
  restoredRows,
  runHolder,
  sha256,
  spawnHolder,
  STOP_TIMEOUT_MS,
  stagingEntries,
  stateFile,
  tableNames,
} from "../../support/database-fixtures.ts";
import { outputEvent, runServerEntry, waitForExit } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const opened = (schemaVersion: number) => ({ event: "database.opened", schemaVersion, created: false });

/** The ID of the operation the gate recorded as active (the one a crash left behind). */
function activeOperationId(instance: TestInstance): string {
  const id = readState(instance).activeOperation?.["operationId"];
  if (typeof id !== "string") throw new Error("no active operation in the gate");
  return id;
}

function metaOf(pkg: string) {
  const verification = verifyDatabaseSnapshot(pkg);
  if (!verification.ok) throw new Error(`${pkg} does not verify: ${verification.fields.join(",")}`);
  return verification.meta;
}

const packageHashes = (pkg: string): string[] => readdirSync(pkg).sort().map((name) => sha256(path.join(pkg, name)));

describe("D05.3-AC1 a crash while taking the snapshot", () => {
  it("before publication: staging is left, no snapshot counts; the next start continues the same operation", async () => {
    const instance = await installationAtB();
    await crashHolderAt(instance, "c", "before-publish");

    expect(packages(instance)).toEqual([]);
    expect(stagingEntries(instance)).toHaveLength(1);
    expect(readState(instance)).toMatchObject({ generation: 2, activeOperation: { reason: "migrate", phase: "snapshot", snapshotId: null } });
    expect(inspectAs(instance, PLAN_B)).toEqual({ kind: "current", schemaVersion: VERSION.b });
    const operationId = activeOperationId(instance);

    expect(await runHolder(instance, "c")).toEqual(opened(VERSION.c));
    expect(stagingEntries(instance)).toEqual([]);
    const [pkg, ...others] = packages(instance);
    expect(others).toEqual([]);
    expect(metaOf(pkg ?? "")).toMatchObject({ operationId, schemaVersion: VERSION.b, reason: "pre_migration" });
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });
    expect(query(databaseFile(instance), noteSummary)).toEqual(expectedNoteSummary);
    expect(inspectAs(instance, PLAN_C)).toEqual({ kind: "current", schemaVersion: VERSION.c });
  });

  it("after publication: the finished snapshot is recognized and verified again, no second one is taken", async () => {
    const instance = await installationAtB();
    await crashHolderAt(instance, "c", "after-publish");

    const [published, ...none] = packages(instance);
    expect(none).toEqual([]);
    const before = metaOf(published ?? "");
    expect(readState(instance)).toMatchObject({ generation: 2, activeOperation: { phase: "snapshot", operationId: before.operationId } });
    expect(inspectAs(instance, PLAN_B)).toEqual({ kind: "current", schemaVersion: VERSION.b });
    const hashes = packageHashes(published ?? "");

    expect(await runHolder(instance, "c")).toEqual(opened(VERSION.c));
    expect(packages(instance)).toEqual([published]);
    expect(packageHashes(published ?? "")).toEqual(hashes);
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });
    expect(manifestIds(databaseFile(instance))).toEqual(PLAN_C.map((migration) => ({ id: migration.id })));
    expect(restoredRows(published ?? "", noteSummary)).toEqual(expectedNoteSummary);
  });

  it("inside the migration: the same operation resumes with its snapshot and completes", async () => {
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
    const [published] = packages(instance);
    const snapshotId = metaOf(published ?? "").snapshotId;
    expect(readState(instance)).toMatchObject({ activeOperation: { phase: "migrating", snapshotId } });
    expect(inspectAs(instance, PLAN_B)).toEqual({ kind: "current", schemaVersion: VERSION.b });

    expect(await runHolder(instance, "c-slow")).toEqual(opened(VERSION.c));
    expect(packages(instance)).toEqual([published]);
    expect(manifestIds(databaseFile(instance))).toEqual(SLOW_C_PLAN.map((migration) => ({ id: migration.id })));
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });
    expect(query(databaseFile(instance), noteSummary)).toEqual(expectedNoteSummary);
  });

  it("a migration that committed before its operation was closed only closes the operation", async () => {
    const instance = await installationAtB();
    expect(await runHolder(instance, "c")).toEqual(opened(VERSION.c));
    const [published] = packages(instance);
    const meta = metaOf(published ?? "");
    // What a crash between the commit and the next gate write leaves: the phase before the commit.
    writeFileSync(
      stateFile(instance),
      JSON.stringify({
        formatVersion: 1,
        generation: 2,
        activeOperation: { operationId: meta.operationId, reason: "migrate", phase: "migrating", startedAt: meta.startedAt, fromSchemaVersion: VERSION.b, toSchemaVersion: VERSION.c, snapshotId: meta.snapshotId },
      }),
    );
    expect(await runHolder(instance, "c")).toEqual(opened(VERSION.c));
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 2, activeOperation: null });
    expect(packages(instance)).toEqual([published]);
    expect(manifestIds(databaseFile(instance))).toEqual(PLAN_C.map((migration) => ({ id: migration.id })));
  });

  it("a published package that no longer verifies is not reused; a new snapshot is taken", async () => {
    const instance = await installationAtB();
    await crashHolderAt(instance, "c", "after-publish");
    const [damaged] = packages(instance);
    const fd = openSync(path.join(damaged ?? "", "app.db"), "r+");
    writeSync(fd, Buffer.from("X"), 0, 1, 200);
    closeSync(fd);
    expect(verifyDatabaseSnapshot(damaged ?? "")).toMatchObject({ ok: false, code: "SNAPSHOT_INVALID" });

    expect(await runHolder(instance, "c")).toEqual(opened(VERSION.c));
    const published = packages(instance);
    expect(published).toHaveLength(2);
    expect(published).toContain(damaged);
    const valid = published.filter((pkg) => verifyDatabaseSnapshot(pkg).ok);
    expect(valid).toHaveLength(1);
    expect(restoredRows(valid[0] ?? "", noteSummary)).toEqual(expectedNoteSummary);
  });
});

describe("D05.3-AC1 states reconciliation does not guess", () => {
  /** An installation at plan B with a crash-like active operation written into the gate. */
  async function withActive(operation: Record<string, unknown>): Promise<TestInstance> {
    const instance = await installationAtB();
    writeFileSync(
      stateFile(instance),
      JSON.stringify({
        formatVersion: 1,
        generation: 2,
        activeOperation: { operationId: "0199f3a4-3c1e-7a00-8000-0000000000aa", reason: "migrate", startedAt: "2026-10-25T10:00:00.000Z", fromSchemaVersion: VERSION.b, toSchemaVersion: VERSION.c, snapshotId: null, ...operation },
      }),
    );
    return instance;
  }

  const recovery = { event: "database.refused", code: "MAINTENANCE_RECOVERY_REQUIRED", fields: ["activeOperation"] };
  it.each([
    ["verifying while the database is still at the old version", { phase: "verifying" }, "c"],
    ["an operation that started from another version", { phase: "snapshot", fromSchemaVersion: VERSION.a }, "c"],
    ["an operation towards a version this image does not have", { phase: "migrating", toSchemaVersion: VERSION.d }, "c"],
    ["a standalone snapshot operation", { reason: "snapshot", phase: "staging", snapshotId: "unfinished", fromSchemaVersion: undefined, toSchemaVersion: undefined }, "c"],
  ])("%s → MAINTENANCE_RECOVERY_REQUIRED, database and gate unchanged", async (_name, operation, plan) => {
    const instance = await withActive(operation);
    const before = [sha256(databaseFile(instance)), sha256(stateFile(instance))];
    expect(await runHolder(instance, plan)).toEqual(recovery);
    expect([sha256(databaseFile(instance)), sha256(stateFile(instance))]).toEqual(before);
    expect(packages(instance)).toEqual([]);
  });

  it("an upgrade operation recorded as snapshot phase while the database already has the new version needs recovery", async () => {
    const instance = await installationAtB();
    expect(await runHolder(instance, "c")).toEqual(opened(VERSION.c));
    writeFileSync(
      stateFile(instance),
      JSON.stringify({
        formatVersion: 1,
        generation: 2,
        activeOperation: { operationId: "0199f3a4-3c1e-7a00-8000-0000000000bb", reason: "migrate", phase: "snapshot", startedAt: "2026-10-25T10:00:00.000Z", fromSchemaVersion: VERSION.b, toSchemaVersion: VERSION.c, snapshotId: null },
      }),
    );
    expect(await runHolder(instance, "c")).toEqual(recovery);
  });
});

describe("D05.3-AC2 a real write error while taking the snapshot", () => {
  /** An installation at plan C whose first upgrade left one good snapshot. */
  async function atCWithGoodSnapshot(): Promise<{ instance: TestInstance; good: string }> {
    const instance = await installationAtB();
    expect(await runHolder(instance, "c")).toEqual(opened(VERSION.c));
    const [good] = packages(instance);
    expect(good).toBeDefined();
    return { instance, good: good ?? "" };
  }

  it("EACCES when the package is published: not completed, migration blocked, last good snapshot untouched, retry succeeds", async () => {
    const { instance, good } = await atCWithGoodSnapshot();
    const goodHashes = packageHashes(good);
    const databaseBefore = sha256(databaseFile(instance));
    // The working area is writable, the backup folder is not: staging, copy, checks and meta
    // succeed, and the rename that would publish the package fails with the file system's EACCES.
    mkdirSync(path.join(backupsDir(instance), ".staging"), { recursive: true });
    chmodSync(backupsDir(instance), 0o555);
    try {
      expect(await runHolder(instance, "d")).toEqual({ event: "database.refused", code: "MIGRATION_SNAPSHOT_REQUIRED", fields: ["schemaVersion"] });
    } finally {
      chmodSync(backupsDir(instance), 0o755);
    }
    expect(packages(instance)).toEqual([good]);
    expect(packageHashes(good)).toEqual(goodHashes);
    expect(verifyDatabaseSnapshot(good).ok).toBe(true);
    expect(stagingEntries(instance)).toEqual([]);
    expect(sha256(databaseFile(instance))).toBe(databaseBefore);
    expect(inspectAs(instance, PLAN_C)).toEqual({ kind: "current", schemaVersion: VERSION.c });
    expect(tableNames(databaseFile(instance))).toEqual([{ name: "harness_extra" }, { name: "harness_note" }]);
    expect(noteColumns(databaseFile(instance))).toEqual([{ name: "id" }, { name: "text" }, { name: "done" }]);
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 3, activeOperation: null });

    expect(await runHolder(instance, "d")).toEqual(opened(VERSION.d));
    expect(packages(instance)).toHaveLength(2);
    expect(packages(instance)).toContain(good);
    expect(manifestIds(databaseFile(instance))).toEqual(PLAN_D.map((migration) => ({ id: migration.id })));
  });

  it("the server of the older image refuses the upgraded database and changes nothing", async () => {
    const { instance } = await atCWithGoodSnapshot();
    const before = [sha256(databaseFile(instance)), sha256(stateFile(instance))];
    const exit = await runServerEntry(["--port", "0", "--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env });
    expect(exit.code).toBe(1);
    expect(outputEvent(exit.output, "bootstrap.failed")).toEqual({ event: "bootstrap.failed", code: "DATABASE_NEWER", fields: ["schemaVersion"] });
    expect([sha256(databaseFile(instance)), sha256(stateFile(instance))]).toEqual(before);
    expect(readFileSync(stateFile(instance), "utf8")).toContain('"activeOperation":null');
  });
});
