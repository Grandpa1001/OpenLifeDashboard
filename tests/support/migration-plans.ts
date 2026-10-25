// Harness migration plans for D04.3/D05 (DEV §9.6): plan A is the product plan of this image,
// the others add or replace migrations that exist only in tests, never in product migrations.
import { PRODUCT_MIGRATION_PLAN, sqlChecksum, type Migration, type MigrationPlan } from "../../packages/sqlite/dist/migrations/public.js";

const harnessMigration = (version: number, id: string, sql: string): Migration => ({ version, id, sql, checksum: sqlChecksum(sql) });

/** Plan A: what the current server image migrates to. */
export const PLAN_A: MigrationPlan = PRODUCT_MIGRATION_PLAN;

/** Plan B: plan A plus one controlled migration, the "next image" of upgrade tests. */
export const PLAN_B: MigrationPlan = [...PLAN_A, harnessMigration(2, "0002-harness-note", "CREATE TABLE harness_note (id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT;\n")];

/**
 * Plan A plus a migration that writes a table and then computes for a few seconds inside the
 * same transaction, so a test can SIGKILL an initialization while its transaction is open.
 */
export const SLOW_PLAN: MigrationPlan = [
  ...PLAN_A,
  harnessMigration(
    2,
    "0002-harness-slow",
    "CREATE TABLE harness_slow (id INTEGER PRIMARY KEY) STRICT;\n" +
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 40000000) SELECT count(*) FROM n;\n",
  ),
];

/** Same tables as plan A under another migration ID: another product's or a newer manifest. */
export const FOREIGN_PLAN: MigrationPlan = PLAN_A.map((migration) => harnessMigration(migration.version, `${migration.id}-other`, migration.sql));

/** Plan A plus a migration whose SQL fails: initialization must leave no table behind. */
export const BROKEN_PLAN: MigrationPlan = [...PLAN_A, harnessMigration(2, "0002-harness-broken", "CREATE TABLE harness_ok (id INTEGER);\nCREATE TABLE harness_ok (id INTEGER);\n")];

/** Plan A plus parent/child tables with a foreign key, for integrity checks of snapshots. */
export const FK_PLAN: MigrationPlan = [
  ...PLAN_A,
  harnessMigration(
    2,
    "0002-harness-parent-child",
    "CREATE TABLE harness_parent (id INTEGER PRIMARY KEY) STRICT;\n" +
      "CREATE TABLE harness_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES harness_parent (id)) STRICT;\n",
  ),
];

export const PLANS: Readonly<Record<string, MigrationPlan>> = { a: PLAN_A, b: PLAN_B, slow: SLOW_PLAN };
