// Initialization of an empty database (Architektura §4.8): every migration of the plan, its
// manifest entry and the installation identity commit in one transaction on the writer, so an
// interrupted initialization leaves either the complete first schema or no table at all.
import type { SqliteConnection } from "../connection/open-database.js";
import { validatePlan, type MigrationPlan } from "./migration.js";

export type InstallationIdentity = Readonly<{
  /** instanceId of control/instance.json; a later start must find the same value. */
  instanceId: string;
  /** UTC ISO timestamp, also recorded as applied_at of each migration. */
  createdAt: string;
}>;

export function initializeDatabase(connection: SqliteConnection, plan: MigrationPlan, identity: InstallationIdentity): void {
  if (connection.role !== "writer") {
    throw new TypeError("initialization needs the writer connection");
  }
  validatePlan(plan);
  const db = connection.handle;
  db.transaction(() => {
    // Migration 1 creates the manifest table, so its entry is written after each migration runs.
    for (const migration of plan) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migration (version, id, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
        migration.version,
        migration.id,
        migration.checksum,
        identity.createdAt,
      );
    }
    db.prepare("INSERT INTO instance (singleton, instance_id, created_at) VALUES (1, ?, ?)").run(identity.instanceId, identity.createdAt);
  }).immediate();
}
