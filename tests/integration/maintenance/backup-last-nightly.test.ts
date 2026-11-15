// D49.2 — the last success of the nightly schedule is read from the folder (Architektura §11.3.2).
// AC1: it is the start of the newest finished nightly copy of this installation, and after a downtime the
//      schedule asks for one copy; the copy it asked for is then the last success and the next slot is the next day's.
// AC2: a damaged package, a copy of another installation and a manual or safety copy are not a success.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideNightlyBackup } from "../../../packages/core/src/modules/maintenance/public.js";
import { lastNightlyStartedAt, listBackups } from "../../../apps/server/dist/adapters/filesystem/backup-catalog.js";
import { createDatabaseSnapshots } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { closeHarnesses, createAppHarness, type AppHarness } from "../../support/app-harness.ts";

afterEach(closeHarnesses);

type Reason = "nightly" | "manual" | "pre_delete";

async function takeCopy(h: AppHarness, reason: Reason, startedAt: string): Promise<string> {
  const store = createDatabaseSnapshots(h.connection, {
    backupsDir: h.backupsDir,
    reserveMiB: 0,
    instanceId: h.instanceId,
    build: { appVersion: "0.0.0", buildRevision: "test", imageDigest: null },
    now: () => startedAt,
    newSnapshotId: randomUUID,
  });
  const result = await store.create({ reason, scope: "database", operationId: randomUUID(), fence: 0 });
  expect(result.ok).toBe(true);
  return (result as { snapshotId: string }).snapshotId;
}

const decideAt = (h: AppHarness, nowIso: string) =>
  decideNightlyBackup({ nowMs: Date.parse(nowIso), timeZone: "Europe/Warsaw", time: "02:00", lastNightlyAt: lastNightlyStartedAt(listBackups(h.backupsDir, h.instanceId)) });

describe("D49.2-AC1 the last success comes from the files", () => {
  it("asks for one copy after a downtime and is satisfied by the copy it asked for", async () => {
    const h = await createAppHarness();
    expect(decideAt(h, "2026-11-15T10:00:00Z")).toEqual({ due: true, slotAtMs: Date.parse("2026-11-15T01:00:00Z") });
    await takeCopy(h, "nightly", "2026-11-12T01:00:00Z");
    await takeCopy(h, "nightly", "2026-11-13T01:00:00Z");
    expect(lastNightlyStartedAt(listBackups(h.backupsDir, h.instanceId))).toBe("2026-11-13T01:00:00Z");
    expect(decideAt(h, "2026-11-15T10:00:00Z")).toEqual({ due: true, slotAtMs: Date.parse("2026-11-15T01:00:00Z") });
    await takeCopy(h, "nightly", "2026-11-15T10:00:00Z");
    expect(decideAt(h, "2026-11-15T10:01:00Z")).toEqual({ due: false, nextAtMs: Date.parse("2026-11-16T01:00:00Z") });
  });
});

describe("D49.2-AC2 only a finished nightly copy of this installation is a success", () => {
  it("ignores a manual copy, a safety copy, a damaged package, a leftover of staging and a copy of another installation", async () => {
    const h = await createAppHarness();
    await takeCopy(h, "nightly", "2026-11-10T01:00:00Z");
    await takeCopy(h, "manual", "2026-11-14T01:00:00Z");
    await takeCopy(h, "pre_delete", "2026-11-14T02:00:00Z");
    const damagedId = await takeCopy(h, "nightly", "2026-11-14T04:00:00Z");
    const damaged = listBackups(h.backupsDir, h.instanceId).find((entry) => entry.state === "completed" && entry.snapshotId === damagedId)!;
    rmSync(path.join(h.backupsDir, damaged.name, "checksums.json"));
    mkdirSync(path.join(h.backupsDir, ".staging", "half"), { recursive: true });
    writeFileSync(path.join(h.backupsDir, ".staging", "half", "app.db"), "partial");
    expect(lastNightlyStartedAt(listBackups(h.backupsDir, h.instanceId))).toBe("2026-11-10T01:00:00Z");
    // The same folder seen by another installation: none of the copies is its own.
    expect(lastNightlyStartedAt(listBackups(h.backupsDir, "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a"))).toBeNull();
  });
});
