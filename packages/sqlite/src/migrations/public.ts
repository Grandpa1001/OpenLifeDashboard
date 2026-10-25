// Public API of the migrations (Architektura §4.7, §4.8, §18.6). Upgrading an existing
// database needs a verified pre_migration snapshot and arrives with it in D05.2.
export { initializeDatabase } from "./initialize-database.js";
export type { InstallationIdentity } from "./initialize-database.js";
export { DATABASE_FIELD, inspectDatabase } from "./inspect-database.js";
export type { DatabaseInspection, DatabaseRefusalCode } from "./inspect-database.js";
export { MigrationPlanError, sqlChecksum, targetSchemaVersion, validatePlan } from "./migration.js";
export type { Migration, MigrationPlan } from "./migration.js";
export { PRODUCT_MIGRATION_PLAN } from "./plan.js";
