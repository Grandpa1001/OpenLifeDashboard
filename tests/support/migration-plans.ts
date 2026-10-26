// Harness migration plans for D04.3/D05 (DEV §9.6): plan A is the product plan of this image,
// the others add or replace migrations that exist only in tests, never in product migrations.
import { PRODUCT_MIGRATION_PLAN, sqlChecksum, targetSchemaVersion, type Migration, type MigrationPlan } from "../../packages/sqlite/dist/migrations/public.js";

/** Harness migrations follow the product plan, whatever its length: `next(0)` is the first. */
const next = (offset: number): number => PRODUCT_MIGRATION_PLAN.length + 1 + offset;
const harnessMigration = (version: number, name: string, sql: string): Migration => ({
  version,
  id: `${String(version).padStart(4, "0")}-${name}`,
  sql,
  checksum: sqlChecksum(sql),
});

/** Plan A: what the current server image migrates to. */
export const PLAN_A: MigrationPlan = PRODUCT_MIGRATION_PLAN;

/** Plan B: plan A plus one controlled migration, the "next image" of upgrade tests. */
export const PLAN_B: MigrationPlan = [...PLAN_A, harnessMigration(next(0), "harness-note", "CREATE TABLE harness_note (id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT;\n")];

/**
 * Plan A plus a migration that writes a table and then computes for a few seconds inside the
 * same transaction, so a test can SIGKILL an initialization while its transaction is open.
 */
export const SLOW_PLAN: MigrationPlan = [
  ...PLAN_A,
  harnessMigration(
    next(0),
    "harness-slow",
    "CREATE TABLE harness_slow (id INTEGER PRIMARY KEY) STRICT;\n" +
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 40000000) SELECT count(*) FROM n;\n",
  ),
];

/** Same tables as plan A under another migration ID: another product's or a newer manifest. */
export const FOREIGN_PLAN: MigrationPlan = PLAN_A.map((migration) => ({ ...migration, id: `${migration.id}-other` }));

/** Plan A plus a migration whose SQL fails: initialization must leave no table behind. */
export const BROKEN_PLAN: MigrationPlan = [...PLAN_A, harnessMigration(next(0), "harness-broken", "CREATE TABLE harness_ok (id INTEGER);\nCREATE TABLE harness_ok (id INTEGER);\n")];

/** Plan A plus parent/child tables with a foreign key, for integrity checks of snapshots. */
export const FK_PLAN: MigrationPlan = [
  ...PLAN_A,
  harnessMigration(
    next(0),
    "harness-parent-child",
    "CREATE TABLE harness_parent (id INTEGER PRIMARY KEY) STRICT;\n" +
      "CREATE TABLE harness_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES harness_parent (id)) STRICT;\n",
  ),
];

/** Plan C: the "next image" after B; it changes a table that holds data and adds one. */
export const PLAN_C: MigrationPlan = [
  ...PLAN_B,
  harnessMigration(
    next(1),
    "harness-extra",
    "ALTER TABLE harness_note ADD COLUMN done INTEGER NOT NULL DEFAULT 0;\nCREATE TABLE harness_extra (id INTEGER PRIMARY KEY) STRICT;\n",
  ),
];

/** Plan C whose last migration changes a table and then fails: the change must be rolled back. */
export const FAILING_C_PLAN: MigrationPlan = [
  ...PLAN_B,
  harnessMigration(
    next(1),
    "harness-fails",
    "ALTER TABLE harness_note ADD COLUMN done INTEGER NOT NULL DEFAULT 0;\nCREATE TABLE harness_ok (id INTEGER);\nCREATE TABLE harness_ok (id INTEGER);\n",
  ),
];

/**
 * Plan C whose last migration succeeds statement by statement but leaves an orphan row behind
 * (a deferred foreign key): only the check inside the transaction can stop it.
 */
export const ORPHAN_C_PLAN: MigrationPlan = [
  ...PLAN_B,
  harnessMigration(
    next(1),
    "harness-orphan",
    "CREATE TABLE harness_parent (id INTEGER PRIMARY KEY) STRICT;\n" +
      "CREATE TABLE harness_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES harness_parent (id) DEFERRABLE INITIALLY DEFERRED) STRICT;\n" +
      "INSERT INTO harness_child (id, parent_id) VALUES (1, 42);\n",
  ),
];

/** Plan C whose last migration computes for seconds inside the upgrade transaction. */
export const SLOW_C_PLAN: MigrationPlan = [
  ...PLAN_B,
  harnessMigration(
    next(1),
    "harness-slow",
    "CREATE TABLE harness_slow (id INTEGER PRIMARY KEY) STRICT;\n" +
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 40000000) SELECT count(*) FROM n;\n",
  ),
];

/** Plan D: the image after C, with one more migration. */
export const PLAN_D: MigrationPlan = [...PLAN_C, harnessMigration(next(2), "harness-more", "CREATE TABLE harness_more (id INTEGER PRIMARY KEY) STRICT;\n")];

/** Schema versions of the plans: tests name them, never a number tied to the product plan. */
export const VERSION = {
  a: targetSchemaVersion(PLAN_A),
  b: targetSchemaVersion(PLAN_B),
  c: targetSchemaVersion(PLAN_C),
  d: targetSchemaVersion(PLAN_D),
} as const;

/** The migration a plan adds on top of its predecessor (its ID in refusals). */
export const lastMigrationId = (plan: MigrationPlan): string => plan.at(-1)?.id ?? "";

export const PLANS: Readonly<Record<string, MigrationPlan>> = {
  a: PLAN_A,
  b: PLAN_B,
  c: PLAN_C,
  d: PLAN_D,
  slow: SLOW_PLAN,
  "c-fails": FAILING_C_PLAN,
  "c-orphan": ORPHAN_C_PLAN,
  "c-slow": SLOW_C_PLAN,
};
