// Shared fixtures of the upgrade and recovery tests (DEV D05.2/D05.3): an installation whose
// database is at harness plan B with domain rows, runs of the "other image" holder, and readers
// for the database, the maintenance gate and published snapshot packages.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { inspectDatabase, type MigrationPlan } from "../../packages/sqlite/dist/migrations/public.js";
import { sharedScratchDir } from "./scratch.ts";
import { freshTestInstance, outputEvent, repoRoot, waitForExit } from "./server-process.ts";
import type { TestInstance } from "./test-instance.ts";

export const NOTES = 25;
export const BUSY_TIMEOUT_MS = 5000;
export const STOP_TIMEOUT_MS = 15_000;
/** Harness plans with a slow migration compute for seconds; allow for slow runners. */
export const HOLDER_TIMEOUT_MS = 60_000;
const DATABASE_HOLDER = path.join(repoRoot, "tests/support/database-holder.ts");


export type GateState = { generation: number; activeOperation: Record<string, unknown> | null };

export const databaseFile = (instance: TestInstance): string => path.join(instance.dir, "data", "app.db");
export const stateFile = (instance: TestInstance): string => path.join(instance.dir, "control", "maintenance", "state.json");
export const backupsDir = (instance: TestInstance): string => path.join(instance.dir, "data", "backup");
export const readState = (instance: TestInstance): GateState => JSON.parse(readFileSync(stateFile(instance), "utf8"));
export const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

export const inspectAs = (instance: TestInstance, plan: MigrationPlan) =>
  inspectDatabase(databaseFile(instance), plan, { instanceId: instance.instanceId, busyTimeoutMs: BUSY_TIMEOUT_MS });

/** Published snapshot packages (not the staging folder), oldest first. */
export const packages = (instance: TestInstance): string[] =>
  readdirSync(backupsDir(instance)).filter((name) => !name.startsWith(".")).sort().map((name) => path.join(backupsDir(instance), name));

/** Leftover working directories of the snapshot adapter. */
export const stagingEntries = (instance: TestInstance): string[] => {
  try {
    return readdirSync(path.join(backupsDir(instance), ".staging"));
  } catch {
    return [];
  }
};

export function query(file: string, sql: string): unknown[] {
  const reader = openDatabase(file, { role: "reader", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    return reader.handle.prepare(sql).all();
  } finally {
    reader.close();
  }
}

/** A standalone copy of a snapshot's database file, opened the way a restore would use it. */
export function restoredRows(pkg: string, sql: string): unknown[] {
  const dir = mkdtempSync(path.join(sharedScratchDir("openlife-db-fixtures-"), "restored-"));
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

export const noteSummary = "SELECT count(*) AS count, sum(id) AS ids, min(text) AS first, max(text) AS last FROM harness_note";
export const expectedNoteSummary = [{ count: NOTES, ids: (NOTES * (NOTES + 1)) / 2, first: "note 0", last: "note 9" }];
export const tableNames = (file: string): unknown[] => query(file, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'harness%' ORDER BY name");
export const noteColumns = (file: string): unknown[] => query(file, "SELECT name FROM pragma_table_info('harness_note') ORDER BY cid");
export const manifestIds = (file: string): unknown[] => query(file, "SELECT id FROM schema_migration ORDER BY version");

export type Holder = Readonly<{ child: ReturnType<typeof spawn>; output: () => string }>;

export function spawnHolder(instance: TestInstance, plan: string, flags: readonly string[] = []): Holder {
  const child = spawn(process.execPath, [DATABASE_HOLDER, instance.dir, plan, ...flags], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return { child, output: () => output };
}

export async function runHolder(instance: TestInstance, plan: string): Promise<Record<string, unknown> | undefined> {
  const holder = spawnHolder(instance, plan);
  const exit = await waitForExit(holder.child, holder.output, HOLDER_TIMEOUT_MS);
  return outputEvent(exit.output, "database.opened") ?? outputEvent(exit.output, "database.refused");
}

/** Starts the holder with a freeze point, waits for it to freeze, kills it and waits for its end. */
export async function crashHolderAt(instance: TestInstance, plan: string, freezeAt: "before-publish" | "after-publish"): Promise<void> {
  const holder = spawnHolder(instance, plan, ["--freeze", freezeAt]);
  const deadline = Date.now() + HOLDER_TIMEOUT_MS;
  while (!holder.output().includes('"holder.frozen"') && holder.child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(outputEvent(holder.output(), "holder.frozen"), holder.output()).toEqual({ event: "holder.frozen", at: freezeAt });
  holder.child.kill("SIGKILL");
  await waitForExit(holder.child, holder.output, STOP_TIMEOUT_MS);
}

/** An installation whose database is at plan B (version 2) with notes in a domain table. */
export async function installationAtB(): Promise<TestInstance> {
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
