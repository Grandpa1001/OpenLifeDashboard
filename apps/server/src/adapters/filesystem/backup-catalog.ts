// The catalog of the backup folder (Architektura §11.3, §11.4; D48.3): what is in it and which of it is a copy.
// Only a published package that passes the whole verification of a restore is `completed`. A published directory
// that does not is `invalid` with the part that failed, and a working directory left in staging by a crash is
// `incomplete`: both are shown and neither is deleted here, because a damaged package is the owner's to judge
// and the retention (D49) is the only thing that removes a package. Hidden entries other than the staging
// folder belong to nobody this module knows and are not listed.
import { lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SnapshotReason, SnapshotScope } from "@openlife/contracts/backups/database-snapshot";
import { SNAPSHOT_STAGING_DIR, verifyDatabaseSnapshot } from "./database-snapshots.js";

export type BackupEntry =
  | Readonly<{
      state: "completed";
      name: string;
      scope: SnapshotScope;
      reason: SnapshotReason;
      snapshotId: string;
      startedAt: string;
      schemaVersion: number;
      bytes: number;
      /** False for a package of another installation: it is a copy, but not of this one. */
      ofThisInstallation: boolean;
    }>
  | Readonly<{ state: "invalid"; name: string; fields: readonly string[] }>
  | Readonly<{ state: "incomplete"; name: string }>;

/** Total size of the regular files directly inside `dir`. */
function directoryBytes(dir: string): number {
  return readdirSync(dir).reduce((sum, file) => sum + statSync(path.join(dir, file)).size, 0);
}

/** The entries of the backup folder, oldest first (the names start with the UTC time); an absent folder is an empty catalog. */
export function listBackups(backupsDir: string, instanceId: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir).sort();
  } catch {
    return [];
  }
  const entries: BackupEntry[] = [];
  for (const name of names.filter((entry) => !entry.startsWith("."))) {
    const dir = path.join(backupsDir, name);
    const verification = verifyDatabaseSnapshot(dir);
    entries.push(
      verification.ok
        ? {
            state: "completed",
            name,
            scope: verification.meta.scope,
            reason: verification.meta.reason,
            snapshotId: verification.meta.snapshotId,
            startedAt: verification.meta.startedAt,
            schemaVersion: verification.meta.schemaVersion,
            bytes: directoryBytes(dir),
            ofThisInstallation: verification.meta.instanceId === instanceId,
          }
        : { state: "invalid", name, fields: verification.fields },
    );
  }
  const staging = path.join(backupsDir, SNAPSHOT_STAGING_DIR);
  try {
    if (lstatSync(staging).isDirectory()) {
      for (const name of readdirSync(staging).sort()) entries.push({ state: "incomplete", name });
    }
  } catch {
    // No staging folder: nothing was ever left in it.
  }
  return entries;
}

/**
 * When the newest finished nightly copy of this installation was started, or null. The last success of the
 * schedule is read from the files and kept nowhere else (D49.2), so a restore or a copied folder cannot make
 * it disagree with the disk; a damaged package and a copy of another installation are not a success.
 */
export function lastNightlyStartedAt(entries: readonly BackupEntry[]): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    if (entry.state === "completed" && entry.ofThisInstallation && entry.reason === "nightly" && (latest === null || entry.startedAt > latest)) latest = entry.startedAt;
  }
  return latest;
}
