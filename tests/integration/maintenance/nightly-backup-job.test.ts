// D49.3 — the nightly backup job of the process (Architektura §11.3.2).
// AC1: on a fake clock and a real folder: after a downtime the job takes one bundle copy and the retention leaves
//      the newest fourteen nightly copies; a second look takes nothing, and the diagnostics state names the last
//      success, the next slot and the retention.
// AC2: an active maintenance operation, a disabled option and a missing owner skip the look; a failed copy is
//      logged with its code, reaches no caller, is not asked again before the wait is over and then is retried;
//      two looks at once take one copy, and stopping waits for the copy that is going on.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { backupStatusSchema } from "../../../packages/contracts/src/http/diagnostics.ts";
import type { DatabaseSnapshotPort, SnapshotResult } from "../../../packages/core/src/modules/maintenance/public.js";
import { listBackups } from "../../../apps/server/dist/adapters/filesystem/backup-catalog.js";
import { pruneBackups } from "../../../apps/server/dist/adapters/filesystem/backup-retention.js";
import { createDatabaseSnapshots } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { exportOfCopy } from "../../../apps/server/dist/portability/bundle-export.js";
import { createNightlyBackupJob, type NightlyBackupJobOptions } from "../../../apps/server/dist/workers/nightly-backup.js";
import { closeHarnesses, createAppHarness, type AppHarness } from "../../support/app-harness.ts";

afterEach(closeHarnesses);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-15T10:00:00Z");
const SETTINGS = { enabled: true, time: "02:00", nightlyKeep: 14, safetyKeepDays: 30 };

type Logged = { level: string; event: string; code?: string };
const newLog = () => {
  const lines: Logged[] = [];
  return { lines, logger: { log: (event: Logged) => void lines.push(event) } };
};

function storeAt(h: AppHarness, atMs: number): DatabaseSnapshotPort {
  return createDatabaseSnapshots(h.connection, {
    backupsDir: h.backupsDir,
    reserveMiB: 0,
    instanceId: h.instanceId,
    build: { appVersion: "0.0.0", buildRevision: "test", imageDigest: null },
    now: () => new Date(atMs).toISOString(),
    newSnapshotId: randomUUID,
    exportOfCopy: (copyFile: string, exportedAt: Date) => exportOfCopy(copyFile, { busyTimeoutMs: 5000, appVersion: "0.0.0", exportedAt }),
  });
}

/** A job on stubs unless told otherwise: the folder is empty and nothing is on disk. */
function stubJob(over: Partial<NightlyBackupJobOptions> & { clock?: { now: number } } = {}) {
  const log = newLog();
  const clock = over.clock ?? { now: NOW };
  const created: unknown[] = [];
  const job = createNightlyBackupJob({
    snapshots: { create: async (request) => (created.push(request), { ok: true, snapshotId: randomUUID() } as SnapshotResult) },
    readCatalog: () => [],
    prune: () => ({ ok: true, kept: [], removed: [] }),
    timeZone: () => "Europe/Warsaw",
    settings: () => SETTINGS,
    nowMs: () => clock.now,
    maintenanceActive: () => false,
    newOperationId: randomUUID,
    logger: log.logger,
    ...over,
  } as NightlyBackupJobOptions);
  return { job, log, created, clock };
}

describe("D49.3-AC1 a catch-up copy after a downtime and the retention of fourteen", () => {
  it("takes one bundle copy, keeps the newest fourteen nightly copies and takes nothing at the next look", async () => {
    const h = await createAppHarness();
    for (let daysAgo = 15; daysAgo >= 1; daysAgo -= 1) {
      const result = await storeAt(h, NOW - daysAgo * DAY).create({ reason: "nightly", scope: "database", operationId: randomUUID(), fence: 0 });
      expect(result.ok).toBe(true);
    }
    const log = newLog();
    const job = createNightlyBackupJob({
      snapshots: storeAt(h, NOW),
      readCatalog: () => listBackups(h.backupsDir, h.instanceId),
      prune: (policy) => pruneBackups(h.backupsDir, h.instanceId, policy),
      timeZone: () => "Europe/Warsaw",
      settings: () => SETTINGS,
      nowMs: () => NOW,
      maintenanceActive: () => false,
      newOperationId: randomUUID,
      logger: log.logger,
    });

    expect(await job.run()).toBe("created");
    const names = readdirSync(h.backupsDir).filter((entry) => !entry.startsWith(".")).sort();
    expect(names).toHaveLength(14);
    const entries = listBackups(h.backupsDir, h.instanceId);
    expect(entries.every((entry) => entry.state === "completed" && entry.reason === "nightly")).toBe(true);
    const newest = entries.at(-1);
    expect(newest?.state === "completed" && newest.scope).toBe("bundle");
    expect(newest?.state === "completed" && newest.startedAt).toBe(new Date(NOW).toISOString());
    expect(log.lines.map((line) => line.event)).toEqual(["backup.nightly_created", "backup.retention_applied"]);

    expect(await job.run()).toBe("not_due");
    expect(backupStatusSchema.safeParse(job.status()).success).toBe(true);
    expect(job.status().nightly).toEqual({
      enabled: true,
      lastSuccessAt: new Date(NOW).toISOString(),
      nextAt: "2026-11-16T01:00:00.000Z",
      lastRun: { at: new Date(NOW).toISOString(), outcome: "created", code: null },
      retention: "ok",
      heartbeat: "not_configured",
    });
    expect(readdirSync(h.backupsDir).filter((entry) => !entry.startsWith("."))).toHaveLength(14);
  });
});

describe("D49.3-AC2 the look is skipped, a failure stays inside, one copy at a time", () => {
  it("skips the look while maintenance is active, when the option is off and before an owner exists", async () => {
    let active = true;
    const { job, created } = stubJob({ maintenanceActive: () => active });
    expect(await job.run()).toBe("maintenance");
    active = false;
    expect(await stubJob({ settings: () => ({ ...SETTINGS, enabled: false }) }).job.run()).toBe("disabled");
    expect(await stubJob({ timeZone: () => null }).job.run()).toBe("no_owner");
    expect(created).toEqual([]);
    expect(await job.run()).toBe("created");
  });

  it("logs a failed copy with its code, waits before the next attempt and then retries", async () => {
    let result: SnapshotResult | "throw" = { ok: false, code: "SNAPSHOT_LOW_SPACE" };
    let attempts = 0;
    const clock = { now: NOW };
    const { job, log } = stubJob({
      clock,
      retryAfterFailureMs: 15 * 60 * 1000,
      snapshots: {
        create: async () => {
          attempts += 1;
          if (result === "throw") throw new Error("disk gone");
          return result;
        },
      } as Pick<DatabaseSnapshotPort, "create">,
    });
    expect(await job.run()).toBe("failed");
    expect(log.lines).toEqual([{ level: "error", event: "backup.nightly_failed", operationId: expect.any(String), code: "SNAPSHOT_LOW_SPACE" }]);
    expect(job.status().nightly.lastRun).toEqual({ at: new Date(NOW).toISOString(), outcome: "failed", code: "SNAPSHOT_LOW_SPACE" });
    clock.now += 60_000;
    expect(await job.run()).toBe("backoff");
    expect(attempts).toBe(1);
    clock.now += 15 * 60 * 1000;
    result = "throw";
    expect(await job.run()).toBe("failed");
    expect(log.lines.at(-1)).toMatchObject({ event: "backup.nightly_failed", code: "NIGHTLY_BACKUP_FAILED" });
    clock.now += 16 * 60 * 1000;
    result = { ok: true, snapshotId: randomUUID() };
    expect(await job.run()).toBe("created");
    expect(attempts).toBe(3);
  });

  it("takes one copy for two looks at once and stop waits for the copy that is going on", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const { job } = stubJob({
      snapshots: {
        create: () => {
          calls += 1;
          return new Promise<SnapshotResult>((resolve) => {
            release = () => resolve({ ok: true, snapshotId: randomUUID() });
          });
        },
      } as Pick<DatabaseSnapshotPort, "create">,
    });
    const first = job.run();
    const second = job.run();
    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(stopped).toBe(false);
    release();
    expect(await first).toBe("created");
    expect(await second).toBe("created");
    await stopping;
    expect(stopped).toBe(true);
  });

  it("records a failed retention without failing the copy", async () => {
    const { job, log } = stubJob({ prune: () => ({ ok: false, code: "RETENTION_FAILED", removed: [] }) });
    expect(await job.run()).toBe("created");
    expect(job.status().nightly.retention).toBe("failed");
    expect(log.lines.map((line) => line.event)).toEqual(["backup.nightly_created", "backup.retention_failed"]);
  });
});

describe("D49.4-AC1/AC2 the signal to the monitor goes after a verified copy and only then", () => {
  const sent = (over: { ok?: boolean } = {}) => {
    const calls: string[] = [];
    return { calls, heartbeat: async () => (calls.push("heartbeat"), over.ok === false ? ({ ok: false, code: "HEARTBEAT_TIMEOUT" } as const) : ({ ok: true } as const)) };
  };

  it("sends one signal after the copy, before the retention, and says so in the state", async () => {
    const order: string[] = [];
    const { job } = stubJob({
      snapshots: { create: async () => (order.push("copy"), { ok: true, snapshotId: randomUUID() } as SnapshotResult) },
      prune: () => (order.push("retention"), { ok: true, kept: [], removed: [] }),
      heartbeat: async () => (order.push("heartbeat"), { ok: true }),
    });
    expect(job.status().nightly.heartbeat).toBe("pending");
    expect(await job.run()).toBe("created");
    expect(order).toEqual(["copy", "heartbeat", "retention"]);
    expect(job.status().nightly.heartbeat).toBe("sent");
    expect(await job.run()).toBe("not_due");
    expect(order).toEqual(["copy", "heartbeat", "retention"]);
  });

  it("sends nothing when the copy failed, when nothing was due and when the look was skipped", async () => {
    const failed = sent();
    const copyFails = stubJob({ snapshots: { create: async () => ({ ok: false, code: "SNAPSHOT_FAILED" }) } as Pick<DatabaseSnapshotPort, "create">, heartbeat: failed.heartbeat });
    expect(await copyFails.job.run()).toBe("failed");
    const skipped = sent();
    expect(await stubJob({ maintenanceActive: () => true, heartbeat: skipped.heartbeat }).job.run()).toBe("maintenance");
    expect(await stubJob({ settings: () => ({ ...SETTINGS, enabled: false }), heartbeat: skipped.heartbeat }).job.run()).toBe("disabled");
    expect(failed.calls).toEqual([]);
    expect(skipped.calls).toEqual([]);
    expect(copyFails.job.status().nightly.heartbeat).toBe("pending");
  });

  it("logs a failed signal with its code, keeps the copy good and still applies the retention", async () => {
    const { calls, heartbeat } = sent({ ok: false });
    const { job, log } = stubJob({ heartbeat });
    expect(await job.run()).toBe("created");
    expect(calls).toEqual(["heartbeat"]);
    expect(job.status().nightly).toMatchObject({ heartbeat: "failed", retention: "ok", lastRun: { outcome: "created" } });
    expect(log.lines).toEqual([
      { level: "info", event: "backup.nightly_created", operationId: expect.any(String), durationMs: 0 },
      { level: "error", event: "backup.heartbeat_failed", operationId: expect.any(String), code: "HEARTBEAT_TIMEOUT" },
      { level: "info", event: "backup.retention_applied", operationId: expect.any(String), durationMs: 0 },
    ]);
  });
});
