// Upgrade of an existing database to the plan of this image (Architektura §4.8; D05.2). Every
// pending migration, its manifest entry and the checks that must hold afterwards run in ONE
// transaction on the writer: a failing SQL statement or a failed check rolls the schema and the
// manifest back together, so the database stays at its version and the verified snapshot taken
// before it is only a safety net. The caller has taken that snapshot and holds the writer lease.
import type { SqliteConnection } from "../connection/open-database.js";
import { validatePlan, type MigrationPlan } from "./migration.js";

export type MigrationOutcome = Readonly<{ fromSchemaVersion: number; toSchemaVersion: number }>;

/** A migration whose SQL or post-condition failed; nothing of the upgrade was kept. */
export class MigrationFailedError extends Error {
  readonly migrationId: string;

  constructor(migrationId: string, cause: unknown) {
    super(`migration ${migrationId} failed`, { cause });
    this.name = "MigrationFailedError";
    this.migrationId = migrationId;
  }
}

function appliedVersion(connection: SqliteConnection): number {
  const version: unknown = connection.handle.prepare("SELECT coalesce(max(version), 0) FROM schema_migration").pluck().get();
  if (typeof version !== "number") {
    throw new TypeError("schema_migration has no readable version");
  }
  return version;
}

/**
 * Applies the migrations after the applied version. The database must already be classified as
 * pending against `plan` (inspectDatabase): the manifest is a prefix of the plan.
 */
export function migrateDatabase(connection: SqliteConnection, plan: MigrationPlan, appliedAt: string): MigrationOutcome {
  if (connection.role !== "writer") {
    throw new TypeError("a migration needs the writer connection");
  }
  validatePlan(plan);
  const db = connection.handle;
  let fromSchemaVersion = 0;
  db.transaction(() => {
    fromSchemaVersion = appliedVersion(connection);
    for (const migration of plan.slice(fromSchemaVersion)) {
      try {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migration (version, id, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
          migration.version,
          migration.id,
          migration.checksum,
          appliedAt,
        );
        // A migration may not leave the data inconsistent: checked before anything is committed.
        const violations: unknown = db.pragma("foreign_key_check");
        if (!Array.isArray(violations) || violations.length > 0) {
          throw new Error("foreign key check failed after the migration");
        }
      } catch (error) {
        throw new MigrationFailedError(migration.id, error);
      }
    }
  }).immediate();
  return { fromSchemaVersion, toSchemaVersion: appliedVersion(connection) };
}
