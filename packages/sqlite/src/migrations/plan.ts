// The migration plan of this image: the single manifest of static application tables
// (Architektura §4.7). Each new migration is appended with the next version.
import { FOUNDATION_MIGRATION } from "./0001-foundation.js";
import { IDENTITY_MIGRATION } from "./0002-identity.js";
import { OWNER_AUDIT_MIGRATION } from "./0003-owner-audit.js";
import { AUTH_LOCKOUT_MIGRATION } from "./0004-auth-lockout.js";
import { MFA_STATE_MIGRATION } from "./0005-mfa-state.js";
import { SETUP_DATA_CHOICE_MIGRATION } from "./0006-setup-data-choice.js";
import { RECOVERY_CODES_MIGRATION } from "./0007-recovery-codes.js";
import { TRUSTED_DEVICE_MIGRATION } from "./0008-trusted-device.js";
import type { MigrationPlan } from "./migration.js";

export const PRODUCT_MIGRATION_PLAN: MigrationPlan = [FOUNDATION_MIGRATION, IDENTITY_MIGRATION, OWNER_AUDIT_MIGRATION, AUTH_LOCKOUT_MIGRATION, MFA_STATE_MIGRATION, SETUP_DATA_CHOICE_MIGRATION, RECOVERY_CODES_MIGRATION, TRUSTED_DEVICE_MIGRATION];
