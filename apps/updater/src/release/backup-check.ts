// The look of the updater at the copy the app says it took (Architektura §11.2.2 step 3, §11.3.1; D54.2). The updater holds
// the backup folder read-only and makes no copy; it checks that the named package is there as the store publishes one: a
// regular directory (a link is refused) with exactly the files of its scope, a `meta.json` of the shape of a snapshot made
// for `pre_update` whose id is the one in the name, and a `checksums.json` that agrees with that `meta.json`. A published
// package was verified in full by the store before the rename that published it (and `backup-verify` repeats it), so the
// updater does not read the database again; it takes the version of the schema from the package.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DATABASE_SNAPSHOT_FILES, snapshotFilesOf, snapshotMetaSchema } from "@openlife/contracts/backups/database-snapshot";
import { backupPackageNameSchema } from "@openlife/contracts/updates/protocol";

export type BackupCode = "BACKUP_MISSING" | "BACKUP_INVALID";
export type BackupCheck = Readonly<{ ok: true; schemaVersion: number }> | Readonly<{ ok: false; code: BackupCode }>;

const META_MAX_BYTES = 64 * 1024;

export function checkBackup(backupDir: string, name: string): BackupCheck {
  if (!backupPackageNameSchema.safeParse(name).success) return { ok: false, code: "BACKUP_INVALID" };
  const dir = path.join(backupDir, name);
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) return { ok: false, code: "BACKUP_INVALID" };
  } catch {
    return { ok: false, code: "BACKUP_MISSING" };
  }
  try {
    const metaText = readFileSync(path.join(dir, DATABASE_SNAPSHOT_FILES.meta), "utf8");
    if (Buffer.byteLength(metaText, "utf8") > META_MAX_BYTES) return { ok: false, code: "BACKUP_INVALID" };
    const meta = snapshotMetaSchema.safeParse(JSON.parse(metaText));
    if (!meta.success || meta.data.reason !== "pre_update" || !name.endsWith(`-pre_update-${meta.data.snapshotId}`)) return { ok: false, code: "BACKUP_INVALID" };
    const present = readdirSync(dir).sort();
    if (JSON.stringify(present) !== JSON.stringify(snapshotFilesOf(meta.data.scope))) return { ok: false, code: "BACKUP_INVALID" };
    for (const file of present) if (!lstatSync(path.join(dir, file)).isFile()) return { ok: false, code: "BACKUP_INVALID" };
    const checksums = JSON.parse(readFileSync(path.join(dir, DATABASE_SNAPSHOT_FILES.checksums), "utf8")) as { files?: Record<string, unknown> };
    if (checksums.files?.[DATABASE_SNAPSHOT_FILES.meta] !== createHash("sha256").update(metaText).digest("hex")) return { ok: false, code: "BACKUP_INVALID" };
    return { ok: true, schemaVersion: meta.data.schemaVersion };
  } catch {
    return { ok: false, code: "BACKUP_INVALID" };
  }
}
