// The nightly backup job (Architektura §11.3.2; D49.3): in the process that holds the writer, outside of any
// request, it takes one `bundle` copy at the time of `backup.time` in the zone of the owner (or one catch-up
// copy after a downtime) and then applies the retention. It looks at the clock once a minute and decides with
// `decideNightlyBackup`; it does nothing while a maintenance operation holds the gate, never runs twice at
// once, and after a failed copy waits before it tries again. A failure is logged with its code and never
// reaches a request. The folder is read once, at the first look: the copies it makes itself keep the
// answer current, and a restore happens with the application stopped.
import { decideNightlyBackup, type DatabaseSnapshotPort, type RetentionPolicy } from "@openlife/core/maintenance";
import type { BackupStatusDto } from "@openlife/contracts/http/diagnostics";
import { lastNightlyStartedAt, type BackupEntry } from "../adapters/filesystem/backup-catalog.js";
import type { pruneBackups } from "../adapters/filesystem/backup-retention.js";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { NIGHTLY_BACKUP_CHECK_INTERVAL_MS, NIGHTLY_BACKUP_FIRST_RUN_DELAY_MS, NIGHTLY_BACKUP_RETRY_AFTER_FAILURE_MS } from "./nightly-backup-limits.js";

export type NightlyBackupSettings = Readonly<{ enabled: boolean; time: string; nightlyKeep: number; safetyKeepDays: number }>;

export type NightlyBackupJobOptions = Readonly<{
  snapshots: Pick<DatabaseSnapshotPort, "create">;
  readCatalog: () => readonly BackupEntry[];
  prune: (policy: RetentionPolicy) => ReturnType<typeof pruneBackups>;
  /** The zone the owner saved; null before the setup. */
  timeZone: () => string | null;
  /** Read at each look: a change of an option applies from the next one. */
  settings: () => NightlyBackupSettings;
  nowMs: () => number;
  /** True while a maintenance operation holds the gate. */
  maintenanceActive: () => boolean;
  newOperationId: () => string;
  logger: Pick<TechnicalLogger, "log">;
  /** Tests narrow the pacing; the product uses the constants. */
  checkIntervalMs?: number;
  firstRunDelayMs?: number;
  retryAfterFailureMs?: number;
}>;

export type NightlyBackupOutcome = "disabled" | "no_owner" | "maintenance" | "not_due" | "backoff" | "created" | "failed";

export type NightlyBackupJob = Readonly<{
  /** One look: takes the copy when it is due. A look already going on is that look. */
  run: () => Promise<NightlyBackupOutcome>;
  /** Starts the schedule: a first look soon, then every interval; the timers do not keep the process alive. */
  start: () => void;
  /** Ends the schedule and waits for the copy that is going on. */
  stop: () => Promise<void>;
  /** The state for the diagnostics. */
  status: () => BackupStatusDto;
}>;

export function createNightlyBackupJob(options: NightlyBackupJobOptions): NightlyBackupJob {
  let going: Promise<NightlyBackupOutcome> | null = null;
  let stopped = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let lastSuccessAt: string | null | undefined;
  let nextAtMs: number | null = null;
  let enabled = true;
  let lastRun: BackupStatusDto["nightly"]["lastRun"] = null;
  let retention: BackupStatusDto["nightly"]["retention"] = null;
  let retryNotBeforeMs = 0;

  function applyRetention(settings: NightlyBackupSettings, operationId: string): void {
    try {
      const outcome = options.prune({ nightlyKeep: settings.nightlyKeep, safetyKeepDays: settings.safetyKeepDays, nowMs: options.nowMs(), inUse: new Set() });
      retention = outcome.ok ? "ok" : "failed";
      if (outcome.ok) options.logger.log({ level: "info", event: "backup.retention_applied", operationId, durationMs: 0 });
      else options.logger.log({ level: "error", event: "backup.retention_failed", operationId, code: outcome.code });
    } catch (error) {
      retention = "failed";
      options.logger.log({ level: "error", event: "backup.retention_failed", operationId, code: "RETENTION_FAILED", error });
    }
  }

  async function look(): Promise<NightlyBackupOutcome> {
    if (stopped) return "not_due";
    const settings = options.settings();
    enabled = settings.enabled;
    if (!settings.enabled) {
      nextAtMs = null;
      return "disabled";
    }
    const timeZone = options.timeZone();
    if (timeZone === null) return "no_owner";
    const now = options.nowMs();
    if (now < retryNotBeforeMs) return "backoff";
    if (options.maintenanceActive()) return "maintenance";
    const operationId = options.newOperationId();
    try {
      lastSuccessAt ??= lastNightlyStartedAt(options.readCatalog());
      const decision = decideNightlyBackup({ nowMs: now, timeZone, time: settings.time, lastNightlyAt: lastSuccessAt });
      if (!decision.due) {
        nextAtMs = decision.nextAtMs;
        return "not_due";
      }
      const result = await options.snapshots.create({ reason: "nightly", scope: "bundle", operationId, fence: 0 });
      const at = new Date(options.nowMs()).toISOString();
      if (!result.ok) {
        lastRun = { at, outcome: "failed", code: result.code };
        retryNotBeforeMs = options.nowMs() + (options.retryAfterFailureMs ?? NIGHTLY_BACKUP_RETRY_AFTER_FAILURE_MS);
        options.logger.log({ level: "error", event: "backup.nightly_failed", operationId, code: result.code });
        return "failed";
      }
      lastSuccessAt = new Date(now).toISOString();
      lastRun = { at, outcome: "created", code: null };
      options.logger.log({ level: "info", event: "backup.nightly_created", operationId, durationMs: options.nowMs() - now });
      applyRetention(settings, operationId);
      const after = decideNightlyBackup({ nowMs: options.nowMs(), timeZone, time: settings.time, lastNightlyAt: lastSuccessAt });
      nextAtMs = after.due ? null : after.nextAtMs;
      return "created";
    } catch (error) {
      lastRun = { at: new Date(options.nowMs()).toISOString(), outcome: "failed", code: "NIGHTLY_BACKUP_FAILED" };
      retryNotBeforeMs = options.nowMs() + (options.retryAfterFailureMs ?? NIGHTLY_BACKUP_RETRY_AFTER_FAILURE_MS);
      options.logger.log({ level: "error", event: "backup.nightly_failed", operationId, code: "NIGHTLY_BACKUP_FAILED", error });
      return "failed";
    }
  }

  const run = (): Promise<NightlyBackupOutcome> => {
    if (going === null) {
      going = look().finally(() => {
        going = null;
      });
    }
    return going;
  };

  return {
    run,
    start: () => {
      stopped = false;
      const first = setTimeout(() => void run(), options.firstRunDelayMs ?? NIGHTLY_BACKUP_FIRST_RUN_DELAY_MS);
      const every = setInterval(() => void run(), options.checkIntervalMs ?? NIGHTLY_BACKUP_CHECK_INTERVAL_MS);
      first.unref();
      every.unref();
      timers.push(first, every);
    },
    stop: async () => {
      stopped = true;
      for (const timer of timers.splice(0)) clearTimeout(timer);
      await going?.catch(() => undefined);
    },
    status: () => ({
      nightly: {
        enabled,
        lastSuccessAt: lastSuccessAt ?? null,
        nextAt: nextAtMs === null ? null : new Date(nextAtMs).toISOString(),
        lastRun,
        retention,
      },
    }),
  };
}
