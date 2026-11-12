// Protocol constants of the audit retention job (Architektura §11.2, §16; D44.5). They bound the work of the
// job; how long entries are kept is the option `audit.retentionDays`, not a constant.

/** Entries one batch removes: one short unit of work. */
export const AUDIT_RETENTION_BATCH_ROWS = 500;

/** Batches one run does at most; a larger backlog is finished by the next runs. */
export const AUDIT_RETENTION_MAX_BATCHES_PER_RUN = 40;

/** How often the job runs, besides once soon after the start. */
export const AUDIT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/** The first run waits this long after the start, so the start itself is not slowed down. */
export const AUDIT_RETENTION_FIRST_RUN_DELAY_MS = 60 * 1000;
