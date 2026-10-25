// Versioned migrations (Architektura §4.7, §4.8). A migration has a consecutive version, a
// stable ID, its SQL and the SHA-256 of that SQL declared next to it. Completed migrations are
// never edited: a changed SQL no longer matches its declaration (caught by validatePlan in
// every test run) and, once applied, no longer matches the checksum stored in the database.
import { createHash } from "node:crypto";

export type Migration = Readonly<{
  version: number;
  id: string;
  sql: string;
  /** SHA-256 (hex) of `sql`, written by hand when the migration is created. */
  checksum: string;
}>;

/** Ordered migrations of one image; the schema version is the version of the last one. */
export type MigrationPlan = readonly Migration[];

const MIGRATION_ID = /^\d{4}-[a-z0-9]+(-[a-z0-9]+)*$/;

export function sqlChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** A plan that breaks these rules is a programming error, never a state of a database. */
export class MigrationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationPlanError";
  }
}

/** Versions 1…n without gaps, unique well-formed IDs and declared checksums that match. */
export function validatePlan(plan: MigrationPlan): void {
  const ids = new Set<string>();
  plan.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationPlanError(`migration ${migration.id} has version ${migration.version}, expected ${index + 1}`);
    }
    if (!MIGRATION_ID.test(migration.id) || ids.has(migration.id)) {
      throw new MigrationPlanError(`migration ID ${migration.id} is malformed or repeated`);
    }
    ids.add(migration.id);
    if (sqlChecksum(migration.sql) !== migration.checksum) {
      throw new MigrationPlanError(`migration ${migration.id} does not match its declared checksum`);
    }
  });
}

export function targetSchemaVersion(plan: MigrationPlan): number {
  return plan.at(-1)?.version ?? 0;
}
