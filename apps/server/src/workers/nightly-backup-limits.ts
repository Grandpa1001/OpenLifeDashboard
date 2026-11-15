// Protocol constants of the nightly backup job (Architektura §11.3.2; D49.3). When the copy is due is the option
// `backup.time` and how many are kept is `backup.nightlyKeep`; these only pace the job.

/** How often the job looks at the clock; a look costs no more than a comparison, the folder is read once. */
export const NIGHTLY_BACKUP_CHECK_INTERVAL_MS = 60 * 1000;

/** The first look waits this long after the start, so the start itself is not slowed down and a late catch-up is not missed. */
export const NIGHTLY_BACKUP_FIRST_RUN_DELAY_MS = 30 * 1000;

/** After a copy failed, the next attempt waits this long: a full disk is not asked again every minute. */
export const NIGHTLY_BACKUP_RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
