// The migration plan of this image: the single manifest of static application tables
// (Architektura §4.7). Each new migration is appended with the next version.
import { FOUNDATION_MIGRATION } from "./0001-foundation.js";
import { IDENTITY_MIGRATION } from "./0002-identity.js";
import type { MigrationPlan } from "./migration.js";

export const PRODUCT_MIGRATION_PLAN: MigrationPlan = [FOUNDATION_MIGRATION, IDENTITY_MIGRATION];
