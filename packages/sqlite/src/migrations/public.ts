// Public API of the migrations (Architektura §4.7, §4.8, §18.6). Upgrading an existing
// database needs a verified pre_migration snapshot, taken by the caller (apps/server bootstrap).
export { initializeDatabase } from "./initialize-database.js";
export type { InstallationIdentity } from "./initialize-database.js";
export { MigrationFailedError, migrateDatabase } from "./migrate-database.js";
export type { MigrationOutcome } from "./migrate-database.js";
export { DATABASE_FIELD, inspectDatabase } from "./inspect-database.js";
export type { DatabaseInspection, DatabaseRefusalCode } from "./inspect-database.js";
export { MigrationPlanError, sqlChecksum, targetSchemaVersion, validatePlan } from "./migration.js";
export type { Migration, MigrationPlan } from "./migration.js";
export { PRODUCT_MIGRATION_PLAN } from "./plan.js";
