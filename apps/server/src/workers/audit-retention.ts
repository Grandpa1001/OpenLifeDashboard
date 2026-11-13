// The audit retention job (Architektura §11.2, §16; D44.5): in the process that holds the writer, outside of
// any request, it removes the entries past `audit.retentionDays` in short batches. Between two batches it
// gives the event loop back, so the requests of the owner are served; it does nothing while a maintenance
// operation holds the gate, never runs twice at once, and ends at the next batch when the server stops. A
// failure is logged with its code and never reaches a request.
import { giveBackLoop } from "../portability/give-back-loop.js";
import { pruneAuditLog, type AuditPruneDependencies } from "@openlife/core/audit";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { AUDIT_RETENTION_BATCH_ROWS, AUDIT_RETENTION_FIRST_RUN_DELAY_MS, AUDIT_RETENTION_INTERVAL_MS, AUDIT_RETENTION_MAX_BATCHES_PER_RUN } from "./audit-retention-limits.js";

export type AuditRetentionJobOptions = Readonly<{
  unit: AuditPruneDependencies["unit"];
  nowMs: () => number;
  /** Read at each run: a change of the option applies from the next one. */
  retentionDays: () => number;
  /** True while a maintenance operation holds the gate. */
  maintenanceActive: () => boolean;
  newOperationId: () => string;
  logger: Pick<TechnicalLogger, "log">;
  /** Tests narrow the bounds; the product uses the constants. */
  batchRows?: number;
  maxBatchesPerRun?: number;
}>;

export type AuditRetentionJob = Readonly<{
  /** One run: batches until nothing is left or the bound is reached. Resolves with the entries removed; a run already going on is that run. */
  run: () => Promise<number>;
  /** Starts the schedule: a first run soon, then every interval; the timers do not keep the process alive. */
  start: () => void;
  /** Ends the schedule and waits for the batch that is going on. */
  stop: () => Promise<void>;
}>;


export function createAuditRetentionJob(options: AuditRetentionJobOptions): AuditRetentionJob {
  const batchRows = options.batchRows ?? AUDIT_RETENTION_BATCH_ROWS;
  const maxBatches = options.maxBatchesPerRun ?? AUDIT_RETENTION_MAX_BATCHES_PER_RUN;
  let going: Promise<number> | null = null;
  let stopped = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  async function runBatches(): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < maxBatches && !stopped; batch += 1) {
      if (options.maintenanceActive()) break;
      const operationId = options.newOperationId();
      let result;
      try {
        result = pruneAuditLog({ unit: options.unit, nowMs: options.nowMs }, { retentionDays: options.retentionDays(), batchRows, operationId });
      } catch (error) {
        options.logger.log({ level: "error", event: "audit.retention_failed", operationId, code: "AUDIT_RETENTION_FAILED", error });
        break;
      }
      if (!result.ok) {
        options.logger.log({ level: "error", event: "audit.retention_failed", operationId, code: result.error.code });
        break;
      }
      removed += result.value.deleted;
      if (result.value.deleted > 0) options.logger.log({ level: "info", event: "audit.retention_pruned", operationId, durationMs: 0 });
      if (result.value.deleted < batchRows) break;
      await giveBackLoop();
    }
    return removed;
  }

  const run = (): Promise<number> => {
    if (going === null) {
      going = runBatches().finally(() => {
        going = null;
      });
    }
    return going;
  };

  return {
    run,
    start: () => {
      stopped = false;
      const first = setTimeout(() => void run(), AUDIT_RETENTION_FIRST_RUN_DELAY_MS);
      const every = setInterval(() => void run(), AUDIT_RETENTION_INTERVAL_MS);
      first.unref();
      every.unref();
      timers.push(first, every);
    },
    stop: async () => {
      stopped = true;
      for (const timer of timers.splice(0)) clearTimeout(timer);
      await going?.catch(() => undefined);
    },
  };
}
