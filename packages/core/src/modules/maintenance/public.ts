// Public API of the maintenance module (Architektura §13.2, §18.4).
export type { DatabaseSnapshotPort, PublishedSnapshot, SnapshotRequest, SnapshotResult } from "./ports.js";
export { planRetention, RETENTION_REASONS } from "./domain/backup-retention.js";
export type { KeepReason, RemoveReason, RetentionCandidate, RetentionPlan, RetentionPolicy, RetentionReason } from "./domain/backup-retention.js";
export { decideNightlyBackup } from "./domain/backup-schedule.js";
export type { NightlyDecision, NightlyInputs } from "./domain/backup-schedule.js";
export { assessRestorable } from "./domain/restore-assessment.js";
export type { CopyFacts, RestoreAssessment, RestorerFacts } from "./domain/restore-assessment.js";
