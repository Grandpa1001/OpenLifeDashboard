// D49.1 — the retention of the backup folder on a real file system (Architektura §11.3.1 point 7, §11.3.2).
// AC1: of five nightly copies a keep of three leaves the newest three on disk and removes the two oldest whole;
//      a copy pre_delete past the days goes while the only old copy pre_type_change and a manual copy stay; what
//      stays still verifies and the staging folder holds nothing afterwards.
// AC2: a damaged package, a leftover of staging, a copy of another installation and a link to a directory outside
//      the folder are not touched and the target of the link keeps its files; a copy in use stays.
// AC3: a removal that cannot be done stops the run with RETENTION_FAILED and names what it had removed; the
//      package it could not remove is still a whole, published copy.
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBackups } from "../../../apps/server/dist/adapters/filesystem/backup-catalog.js";
import { pruneBackups } from "../../../apps/server/dist/adapters/filesystem/backup-retention.js";
import { createDatabaseSnapshots, verifyDatabaseSnapshot } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { closeHarnesses, createAppHarness, type AppHarness } from "../../support/app-harness.ts";

afterEach(closeHarnesses);

const NOW = Date.parse("2026-11-15T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const POLICY = { nightlyKeep: 3, safetyKeepDays: 30, nowMs: NOW, inUse: new Set<string>() };
type Reason = "nightly" | "manual" | "pre_delete" | "pre_type_change";

/** A copy whose clock says it was taken `daysAgo` days before NOW; the package is a real one. */
async function takeCopy(h: AppHarness, reason: Reason, daysAgo: number): Promise<string> {
  const store = createDatabaseSnapshots(h.connection, {
    backupsDir: h.backupsDir,
    reserveMiB: 0,
    instanceId: h.instanceId,
    build: { appVersion: "0.0.0", buildRevision: "test", imageDigest: null },
    now: () => new Date(NOW - daysAgo * DAY).toISOString(),
    newSnapshotId: randomUUID,
  });
  const result = await store.create({ reason, scope: "database", operationId: randomUUID(), fence: 0 });
  expect(result.ok).toBe(true);
  const created = listBackups(h.backupsDir, h.instanceId).find((entry) => entry.state === "completed" && entry.snapshotId === (result as { snapshotId: string }).snapshotId);
  return created!.name;
}

const names = (h: AppHarness): string[] => readdirSync(h.backupsDir).filter((entry) => !entry.startsWith(".")).sort();

describe("D49.1-AC1 the retention removes what the limits say and keeps the rest whole", () => {
  it("keeps the newest three of five nightly copies, removes the old pre_delete and keeps the lone old pre_type_change and the manual copy", async () => {
    const h = await createAppHarness();
    const nightly = [] as string[];
    for (const day of [5, 4, 3, 2, 1]) nightly.push(await takeCopy(h, "nightly", day));
    const oldDelete = await takeCopy(h, "pre_delete", 40);
    const lone = await takeCopy(h, "pre_type_change", 200);
    const manual = await takeCopy(h, "manual", 300);
    const newDelete = await takeCopy(h, "pre_delete", 2);

    const outcome = pruneBackups(h.backupsDir, h.instanceId, POLICY);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The run goes from the newest of the removed to the oldest.
    expect(outcome.removed.map((each) => [each.name, each.why]).sort()).toEqual([[nightly[0], "over_limit"], [nightly[1], "over_limit"], [oldDelete, "expired"]].sort());
    expect(names(h)).toEqual([nightly[2], nightly[3], nightly[4], lone, manual, newDelete].sort());
    for (const name of names(h)) expect(verifyDatabaseSnapshot(path.join(h.backupsDir, name)).ok).toBe(true);
    expect(readdirSync(path.join(h.backupsDir, ".staging"))).toEqual([]);
  });
});

describe("D49.1-AC2 only a verified copy of this installation is a candidate", () => {
  it("leaves a damaged package, a leftover of staging, a link to an outside directory and a copy of another installation alone; a copy in use stays", async () => {
    const h = await createAppHarness();
    const nightly = [] as string[];
    for (const day of [6, 5, 4, 3, 2]) nightly.push(await takeCopy(h, "nightly", day));
    // A damaged package (a file gone) is not completed, so not a candidate however old.
    const damaged = path.join(h.backupsDir, "20200101T000000Z-nightly-00000000-0000-4000-8000-000000000000");
    mkdirSync(damaged);
    writeFileSync(path.join(damaged, "app.db"), "not a database");
    mkdirSync(path.join(h.backupsDir, ".staging", "20200102T000000Z-nightly-half"), { recursive: true });
    const outside = path.join(h.backupsDir, "..", "outside-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "keep.txt"), "mine");
    symlinkSync(outside, path.join(h.backupsDir, "20200103T000000Z-nightly-link"));

    const outcome = pruneBackups(h.backupsDir, h.instanceId, { ...POLICY, inUse: new Set([nightly[0]!]) });
    expect(outcome.ok && outcome.removed.map((each) => each.name)).toEqual([nightly[1]]);
    expect(existsSync(path.join(h.backupsDir, nightly[0]!))).toBe(true);
    expect(existsSync(damaged)).toBe(true);
    expect(existsSync(path.join(h.backupsDir, ".staging", "20200102T000000Z-nightly-half"))).toBe(true);
    expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(path.join(h.backupsDir, "20200103T000000Z-nightly-link"))).toBe(true);

    // The same folder seen by another installation: none of the copies is its own, so nothing is a candidate.
    const before = names(h);
    const foreign = pruneBackups(h.backupsDir, "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", POLICY);
    expect(foreign.ok && foreign.removed).toEqual([]);
    expect(names(h)).toEqual(before);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("D49.1-AC3 a removal that fails stops the run and leaves a whole copy", () => {
  it("answers RETENTION_FAILED with what it had removed, and the package it could not remove still verifies", async () => {
    const h = await createAppHarness();
    const nightly = [] as string[];
    for (const day of [5, 4, 3, 2, 1]) nightly.push(await takeCopy(h, "nightly", day));
    // The run removes the newest of the removed first: the third, then the second. The place the second is to be
    // parked in is taken by a directory that is not empty.
    const blocker = path.join(h.backupsDir, ".staging", `removing-${nightly[1]}`);
    mkdirSync(blocker, { recursive: true });
    writeFileSync(path.join(blocker, "x"), "x");

    const outcome = pruneBackups(h.backupsDir, h.instanceId, { ...POLICY, nightlyKeep: 2 });
    expect(outcome).toEqual({ ok: false, code: "RETENTION_FAILED", removed: [nightly[2]] });
    expect(existsSync(path.join(h.backupsDir, nightly[2]!))).toBe(false);
    expect(verifyDatabaseSnapshot(path.join(h.backupsDir, nightly[1]!)).ok).toBe(true);
  });
});
