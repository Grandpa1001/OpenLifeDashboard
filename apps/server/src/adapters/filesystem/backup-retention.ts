// The retention of the backup folder (Architektura §11.3.1 point 7, §11.3.2; D49.1): applies the plan of the
// core to the finished copies of this installation. It runs only after a copy has been made and verified, and it
// removes nothing it has not verified as a completed package of this installation: a damaged directory, a
// leftover of staging, a copy of another installation and a link to anywhere are not candidates, so they are
// never followed or deleted. A package leaves the list of copies first (a rename into the staging folder, which
// is never a copy and is discarded by the next snapshot), so a removal that stops half way cannot leave a
// directory that looks published and is not whole.
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { planRetention, type KeepReason, type RemoveReason, type RetentionPolicy } from "@openlife/core/maintenance";
import { listBackups } from "./backup-catalog.js";
import { syncDirectory } from "./durable-files.js";
import { SNAPSHOT_STAGING_DIR } from "./database-snapshots.js";

export type RetentionOutcome =
  | Readonly<{ ok: true; kept: ReadonlyArray<Readonly<{ name: string; why: KeepReason }>>; removed: ReadonlyArray<Readonly<{ name: string; why: RemoveReason }>> }>
  | Readonly<{ ok: false; code: "RETENTION_FAILED"; removed: readonly string[] }>;

export function pruneBackups(backupsDir: string, instanceId: string, policy: RetentionPolicy): RetentionOutcome {
  const candidates = listBackups(backupsDir, instanceId).flatMap((entry) =>
    entry.state === "completed" && entry.ofThisInstallation ? [{ name: entry.name, reason: entry.reason, startedAt: entry.startedAt }] : [],
  );
  const plan = planRetention(candidates, policy);
  const removed: Array<{ name: string; why: RemoveReason }> = [];
  try {
    for (const target of plan.remove) {
      const dir = path.join(backupsDir, target.name);
      // The catalog verified it as a directory, but it is looked at once more before it is touched.
      if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
      const staging = path.join(backupsDir, SNAPSHOT_STAGING_DIR);
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const parked = path.join(staging, `removing-${target.name}`);
      renameSync(dir, parked);
      syncDirectory(backupsDir);
      rmSync(parked, { recursive: true, force: true });
      removed.push(target);
    }
  } catch {
    return { ok: false, code: "RETENTION_FAILED", removed: removed.map((each) => each.name) };
  }
  return { ok: true, kept: plan.keep, removed };
}
