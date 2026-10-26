// D04.3 — migration plan, inspection and initialization on real database files.
// AC1: an empty file initializes in one transaction (all tables, manifest, instance identity);
//      a failing migration leaves no table; the initialized file inspects as current.
// AC2: a pending plan, a newer or foreign manifest, a changed checksum, another instance, a
//      foreign SQLite file and a non-SQLite file are classified without changing the file.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import {
  inspectDatabase,
  initializeDatabase,
  MigrationPlanError,
  PRODUCT_MIGRATION_PLAN,
  validatePlan,
  type MigrationPlan,
} from "../../../packages/sqlite/dist/migrations/public.js";
import { readJsonObject } from "../../../scripts/support/workspaces.ts";
import { BROKEN_PLAN, FOREIGN_PLAN, PLAN_A, PLAN_B, VERSION } from "../../support/migration-plans.ts";
import { repoRoot } from "../../support/server-process.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-migrations-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const INSTANCE_ID = "3f1c2a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const CREATED_AT = "2026-10-25T12:00:00.000Z";
const BUSY_TIMEOUT_MS = 5000;
const expected = { instanceId: INSTANCE_ID, busyTimeoutMs: BUSY_TIMEOUT_MS };
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

let counter = 0;
/** The path of app.db in a new, empty directory of its own. */
function nextFile(): string {
  const dir = path.join(scratch, `db-${(counter += 1)}`);
  mkdirSync(dir);
  return path.join(dir, "app.db");
}

/** A database file initialized with `plan` through the production initializer. */
function initialized(plan: MigrationPlan, instanceId = INSTANCE_ID): string {
  const file = nextFile();
  const writer = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  initializeDatabase(writer, plan, { instanceId, createdAt: CREATED_AT });
  writer.close();
  return file;
}

/** Runs `sql` on the file through a writer connection (fault injection only). */
function tamper(file: string, sql: string): void {
  const writer = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
  writer.handle.exec(sql);
  writer.close();
}

function readRows(file: string, sql: string): unknown[] {
  const reader = openDatabase(file, { role: "reader", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    return reader.handle.prepare(sql).all();
  } finally {
    reader.close();
  }
}

describe("D04.3 migration plan", () => {
  it("the product plan has consecutive versions, unique IDs and matching declared checksums", () => {
    expect(() => validatePlan(PRODUCT_MIGRATION_PLAN)).not.toThrow();
    expect(PRODUCT_MIGRATION_PLAN.map((migration) => migration.id)).toEqual(["0001-foundation", "0002-identity", "0003-owner-audit", "0004-auth-lockout", "0005-mfa-state", "0006-setup-data-choice", "0007-recovery-codes"]);
  });

  const first = PLAN_A[0];
  const second = PLAN_B[1];
  it.each<[string, MigrationPlan]>([
    ["an edited SQL without a new checksum", PLAN_A.map((migration) => ({ ...migration, sql: `${migration.sql}-- edited\n` }))],
    ["a gap in the versions", second ? [second] : []],
    ["a repeated migration ID", first ? [first, { ...first, version: 2 }] : []],
  ])("%s is a plan error", (_name, plan) => {
    expect(plan.length).toBeGreaterThan(0);
    expect(() => validatePlan(plan)).toThrow(MigrationPlanError);
  });

  it("no ORM push or second migrator is part of any workspace script", () => {
    for (const manifest of ["package.json", "packages/sqlite/package.json", "apps/server/package.json"]) {
      const scripts = JSON.stringify(readJsonObject(path.join(repoRoot, manifest))["scripts"] ?? {});
      expect(scripts).not.toMatch(/push|drizzle-kit|migrate/);
    }
  });
});

describe("D04.3-AC1 initialization of an empty database", () => {
  it("writes every migration, its manifest entry and the instance identity in one transaction", () => {
    const file = initialized(PLAN_B);
    expect(readRows(file, "SELECT version, id, checksum, applied_at FROM schema_migration ORDER BY version")).toEqual(
      PLAN_B.map((migration) => ({ version: migration.version, id: migration.id, checksum: migration.checksum, applied_at: CREATED_AT })),
    );
    expect(readRows(file, "SELECT singleton, instance_id, created_at FROM instance")).toEqual([{ singleton: 1, instance_id: INSTANCE_ID, created_at: CREATED_AT }]);
    expect(inspectDatabase(file, PLAN_B, expected)).toEqual({ kind: "current", schemaVersion: VERSION.b });
  });

  it("a failing migration leaves no table and the file still inspects as empty", () => {
    const file = nextFile();
    const writer = openDatabase(file, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS });
    expect(() => initializeDatabase(writer, BROKEN_PLAN, { instanceId: INSTANCE_ID, createdAt: CREATED_AT })).toThrow(/already exists/);
    expect(writer.handle.prepare("SELECT count(*) FROM sqlite_schema").pluck().get()).toBe(0);
    writer.close();
    expect(inspectDatabase(file, PLAN_A, expected)).toEqual({ kind: "empty" });
  });

  it("a missing file, an empty file and a WAL database without tables are empty", () => {
    const file = nextFile();
    expect(inspectDatabase(file, PLAN_A, expected)).toEqual({ kind: "empty" });
    writeFileSync(file, "");
    expect(inspectDatabase(file, PLAN_A, expected)).toEqual({ kind: "empty" });
    const walOnly = nextFile();
    openDatabase(walOnly, { role: "writer", busyTimeoutMs: BUSY_TIMEOUT_MS }).close();
    expect(inspectDatabase(walOnly, PLAN_A, expected)).toEqual({ kind: "empty" });
  });
});

describe("D04.3-AC2 classification without changing the file", () => {
  const unrecognized = { kind: "refused", code: "DATABASE_UNRECOGNIZED", fields: ["database"] };

  function expectUnchanged(file: string, inspect: () => unknown, result: unknown): void {
    const before = sha256(file);
    expect(inspect()).toEqual(result);
    expect(sha256(file)).toBe(before);
  }

  it("plan B on a plan A database is a pending upgrade from 1 to 2", () => {
    const file = initialized(PLAN_A);
    expectUnchanged(file, () => inspectDatabase(file, PLAN_B, expected), { kind: "pending", fromSchemaVersion: VERSION.a, toSchemaVersion: VERSION.b });
  });

  it("a database of a newer plan is DATABASE_NEWER for the older image", () => {
    const file = initialized(PLAN_B);
    expectUnchanged(file, () => inspectDatabase(file, PLAN_A, expected), { kind: "refused", code: "DATABASE_NEWER", fields: ["schemaVersion"] });
  });

  it("a manifest with unknown migration IDs is DATABASE_NEWER", () => {
    const file = initialized(FOREIGN_PLAN);
    expectUnchanged(file, () => inspectDatabase(file, PLAN_A, expected), { kind: "refused", code: "DATABASE_NEWER", fields: ["schemaVersion"] });
  });

  it("an applied migration with another checksum is MIGRATION_CHECKSUM_MISMATCH", () => {
    const file = initialized(PLAN_A);
    tamper(file, `UPDATE schema_migration SET checksum = '${"0".repeat(64)}' WHERE version = 1`);
    expectUnchanged(file, () => inspectDatabase(file, PLAN_A, expected), { kind: "refused", code: "MIGRATION_CHECKSUM_MISMATCH", fields: ["0001-foundation"] });
  });

  it("another installation's database is INSTANCE_METADATA_INVALID [instanceId]", () => {
    const file = initialized(PLAN_A, "9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0");
    expectUnchanged(file, () => inspectDatabase(file, PLAN_A, expected), { kind: "refused", code: "INSTANCE_METADATA_INVALID", fields: ["instanceId"] });
  });

  it("a non-SQLite file is unrecognized", () => {
    const file = nextFile();
    writeFileSync(file, "not a database, but somebody's notes\n");
    expectUnchanged(file, () => inspectDatabase(file, PLAN_A, expected), unrecognized);
  });

  it("a foreign rollback-journal SQLite file is unrecognized from its header, without companions", () => {
    const file = nextFile();
    // Switched back to a rollback journal before closing: a plain SQLite file of another program.
    tamper(file, "CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('keep me'); PRAGMA journal_mode = DELETE;");
    expect(readdirSync(path.dirname(file))).toEqual(["app.db"]);
    expectUnchanged(file, () => inspectDatabase(file, PLAN_A, expected), unrecognized);
    expect(readdirSync(path.dirname(file))).toEqual(["app.db"]);
  });

  it("a foreign WAL SQLite database with its own tables is unrecognized", () => {
    const file = nextFile();
    tamper(file, "CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('keep me');");
    expectUnchanged(file, () => inspectDatabase(file, PLAN_A, expected), unrecognized);
  });

  it("journal companions without their database are unrecognized, nothing is created", () => {
    const file = nextFile();
    writeFileSync(`${file}-wal`, "left over");
    expect(inspectDatabase(file, PLAN_A, expected)).toEqual(unrecognized);
    expect(existsSync(file)).toBe(false);
  });
});
