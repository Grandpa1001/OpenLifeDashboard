// DatabaseSnapshotPort on the installation's backup folder (Architektura §11.3.1, §11.4; D05.1).
// A snapshot is built in data/backup/.staging/<name>, checked there in full and only then
// published by a rename into data/backup/<name> on the same mount: a published directory is a
// verified package, a staging directory never is. The caller holds the writer lease; the copy
// is read through the writer connection (Backup API), never by copying the database file.
// Staging left by a crash is discarded before the next snapshot and by discardUnpublished; a
// package is found again only by findPublished, which verifies it anew (D05.3).
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import {
  BUNDLE_EXPORT_FILE,
  bundleSnapshotChecksumsSchema,
  DATABASE_SNAPSHOT_FILES,
  DATABASE_SNAPSHOT_META_VERSION,
  databaseSnapshotChecksumsSchema,
  snapshotFilesOf,
  snapshotMetaSchema,
  type SnapshotMeta,
  type SnapshotScope,
} from "@openlife/contracts/backups/database-snapshot";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "@openlife/contracts/export/format";
import type { DatabaseSnapshotPort, PublishedSnapshot, SnapshotResult } from "@openlife/core/maintenance";
import type { SqliteConnection } from "@openlife/sqlite/connection";
import { copyDatabase, examineDatabaseCopy } from "@openlife/sqlite/snapshots";
import { syncDirectory, syncFile, writeNewFileDurably, writeNewFileFromChunks } from "./durable-files.js";

/** Working area inside the backup folder; nothing in it is a usable snapshot. */
export const SNAPSHOT_STAGING_DIR = ".staging";
const MIB = 1024 * 1024;

export type AppBuild = Readonly<{
  appVersion: string;
  buildRevision: string;
  /** Digest of the published image; null for a local image without a release manifest. */
  imageDigest: string | null;
}>;

export type SnapshotStoreOptions = Readonly<{
  backupsDir: string;
  /** backup.diskReserveMiB: free space that must remain after the copy. */
  reserveMiB: number;
  instanceId: string;
  build: AppBuild;
  now: () => string;
  newSnapshotId: () => string;
  /**
   * The export document of the copy of the database at that path (D48). Without it the store makes only
   * `database` packages and a request for a `bundle` is SNAPSHOT_UNAVAILABLE.
   */
  exportOfCopy?: (copyFile: string, exportedAt: Date) => AsyncIterable<string>;
}>;

export type SnapshotVerification =
  | Readonly<{ ok: true; meta: SnapshotMeta }>
  | Readonly<{ ok: false; code: "SNAPSHOT_INVALID"; fields: readonly string[] }>;

const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const invalid = (...fields: string[]): SnapshotVerification => ({ ok: false, code: "SNAPSHOT_INVALID", fields });

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Directory name: UTC start, reason and ID, so a listing sorts chronologically. */
export function snapshotDirectoryName(startedAt: string, reason: string, snapshotId: string): string {
  return `${startedAt.replace(/[-:]|\.\d+/g, "")}-${reason}-${snapshotId}`;
}

/**
 * Checks a package directory as a restore or migration would rely on it: exactly the three
 * files, matching checksums, valid meta, and a copy that passes integrity and foreign key checks
 * and agrees with its meta. Anything else is SNAPSHOT_INVALID with the part that failed.
 */
export function verifyDatabaseSnapshot(dir: string): SnapshotVerification {
  try {
    if (!lstatSync(dir).isDirectory()) {
      return invalid("directory");
    }
  } catch {
    return invalid("directory");
  }
  const at = (name: string): string => path.join(dir, name);
  const present = readdirSync(dir).sort();
  // The set of files depends on the scope the meta names; when the meta cannot be read, an export.json beside
  // app.db says the package meant to be a bundle, so its damage is reported on the meta and not on the file set.
  const claimed = snapshotMetaSchema.safeParse(readJson(at(DATABASE_SNAPSHOT_FILES.meta)));
  const scope: SnapshotScope = claimed.success ? claimed.data.scope : present.includes(BUNDLE_EXPORT_FILE) ? "bundle" : "database";
  const regular = present.every((name) => lstatSync(at(name)).isFile());
  if (JSON.stringify(present) !== JSON.stringify(snapshotFilesOf(scope)) || !regular) {
    return invalid("files");
  }
  const checksums = (scope === "bundle" ? bundleSnapshotChecksumsSchema : databaseSnapshotChecksumsSchema).safeParse(readJson(at(DATABASE_SNAPSHOT_FILES.checksums)));
  if (!checksums.success) {
    return invalid(DATABASE_SNAPSHOT_FILES.checksums);
  }
  const named = checksums.data.files as Readonly<Record<string, string>>;
  const changed = Object.keys(named).filter((name) => sha256File(at(name)) !== named[name]);
  if (changed.length > 0) {
    return invalid(...changed);
  }
  if (!claimed.success) {
    return invalid(DATABASE_SNAPSHOT_FILES.meta);
  }
  const meta = claimed.data;
  const copy = examineDatabaseCopy(at(DATABASE_SNAPSHOT_FILES.database));
  if (!copy.ok) {
    return invalid(copy.problem);
  }
  const disagreeing = [
    copy.facts.schemaVersion === meta.schemaVersion ? [] : ["schemaVersion"],
    copy.facts.instanceId === meta.instanceId ? [] : ["instanceId"],
    copy.facts.bytes === meta.databaseBytes ? [] : ["databaseBytes"],
    meta.scope === "bundle" && !exportHeaderMatches(at(BUNDLE_EXPORT_FILE), meta.formatVersion) ? [BUNDLE_EXPORT_FILE] : [],
  ].flat();
  return disagreeing.length > 0 ? invalid(...disagreeing) : { ok: true, meta };
}

/** The first bytes of export.json name the format and its version (the document writes them first); a full parse is the restore's job. */
function exportHeaderMatches(file: string, formatVersion: number): boolean {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(256);
    const text = head.toString("utf8", 0, readSync(fd, head, 0, head.length, 0));
    return text.includes(`"format": ${JSON.stringify(EXPORT_FORMAT)}`) && text.includes(`"formatVersion": ${formatVersion},`);
  } finally {
    closeSync(fd);
  }
}

/** Database plus WAL: the conservative size of the new copy (Architektura §11.4). */
function sourceBytes(databaseFile: string): number {
  return [databaseFile, `${databaseFile}-wal`].reduce((sum, file) => {
    try {
      return sum + statSync(file).size;
    } catch {
      return sum;
    }
  }, 0);
}

/** Staging directories of this backup folder; empty when none was ever created. */
function discardStaging(backupsDir: string): void {
  const root = path.join(backupsDir, SNAPSHOT_STAGING_DIR);
  let entries: string[];
  try {
    if (!lstatSync(root).isDirectory()) {
      return;
    }
    entries = readdirSync(root);
  } catch {
    return;
  }
  // Under the writer lease only this adapter stages, so every entry is left over from a crash.
  // rmSync removes a symlink itself and never follows it.
  for (const entry of entries) {
    rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

/** Published (non-hidden) package directories, never the staging folder. */
function publishedPackages(backupsDir: string): string[] {
  try {
    return readdirSync(backupsDir)
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => path.join(backupsDir, name));
  } catch {
    return [];
  }
}

function stagingRoot(backupsDir: string): string {
  const root = path.join(backupsDir, SNAPSHOT_STAGING_DIR);
  try {
    if (!lstatSync(root).isDirectory()) {
      throw new Error(`${SNAPSHOT_STAGING_DIR} is not a directory`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    mkdirSync(root, { mode: 0o700 });
    syncDirectory(backupsDir);
  }
  return root;
}

export function createDatabaseSnapshots(source: SqliteConnection, options: SnapshotStoreOptions): DatabaseSnapshotPort {
  return {
    findPublished(operationId): Promise<PublishedSnapshot | undefined> {
      for (const dir of publishedPackages(options.backupsDir)) {
        // The cheap meta check first: the full verification (integrity_check) runs only for the
        // package that claims this operation, not for every package in the folder.
        const claimed = snapshotMetaSchema.safeParse(readJson(path.join(dir, DATABASE_SNAPSHOT_FILES.meta)));
        if (!claimed.success || claimed.data.operationId !== operationId) {
          continue;
        }
        const verification = verifyDatabaseSnapshot(dir);
        if (verification.ok && verification.meta.instanceId === options.instanceId) {
          return Promise.resolve({ snapshotId: verification.meta.snapshotId, schemaVersion: verification.meta.schemaVersion });
        }
      }
      return Promise.resolve(undefined);
    },
    discardUnpublished(): Promise<void> {
      discardStaging(options.backupsDir);
      return Promise.resolve();
    },
    async create(request): Promise<SnapshotResult> {
      if (request.scope === "bundle" && options.exportOfCopy === undefined) {
        return { ok: false, code: "SNAPSHOT_UNAVAILABLE" };
      }
      let free: number;
      try {
        const stats = statfsSync(options.backupsDir);
        free = stats.bavail * stats.bsize;
      } catch {
        return { ok: false, code: "SNAPSHOT_FAILED" };
      }
      if (free < sourceBytes(source.handle.name) + options.reserveMiB * MIB) {
        return { ok: false, code: "SNAPSHOT_LOW_SPACE" };
      }
      const snapshotId = options.newSnapshotId();
      const startedAt = options.now();
      const name = snapshotDirectoryName(startedAt, request.reason, snapshotId);
      let staging: string | undefined;
      try {
        discardStaging(options.backupsDir);
        const root = stagingRoot(options.backupsDir);
        staging = path.join(root, name);
        mkdirSync(staging, { mode: 0o700 });
        const databaseFile = path.join(staging, DATABASE_SNAPSHOT_FILES.database);
        await copyDatabase(source, databaseFile);
        syncFile(databaseFile);
        const copy = examineDatabaseCopy(databaseFile);
        if (!copy.ok || copy.facts.instanceId !== options.instanceId) {
          return { ok: false, code: "SNAPSHOT_FAILED" };
        }
        // The export is made from the copy just taken, so it and app.db are one state (D48).
        const exportFile = path.join(staging, BUNDLE_EXPORT_FILE);
        if (request.scope === "bundle" && options.exportOfCopy !== undefined) {
          await writeNewFileFromChunks(exportFile, options.exportOfCopy(databaseFile, new Date(options.now())));
        }
        const base = {
          metaVersion: DATABASE_SNAPSHOT_META_VERSION,
          snapshotId,
          operationId: request.operationId,
          instanceId: options.instanceId,
          reason: request.reason,
          ...options.build,
          schemaVersion: copy.facts.schemaVersion,
          startedAt,
          completedAt: options.now(),
          databaseBytes: copy.facts.bytes,
          requiresOriginalKeys: true,
        } as const;
        const meta: SnapshotMeta = request.scope === "bundle" ? { ...base, scope: "bundle", formatVersion: EXPORT_FORMAT_VERSION } : { ...base, scope: "database" };
        const metaFile = path.join(staging, DATABASE_SNAPSHOT_FILES.meta);
        writeNewFileDurably(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
        const checksums = {
          algorithm: "sha256",
          files: {
            [DATABASE_SNAPSHOT_FILES.database]: sha256File(databaseFile),
            [DATABASE_SNAPSHOT_FILES.meta]: sha256File(metaFile),
            ...(request.scope === "bundle" ? { [BUNDLE_EXPORT_FILE]: sha256File(exportFile) } : {}),
          },
        };
        writeNewFileDurably(path.join(staging, DATABASE_SNAPSHOT_FILES.checksums), `${JSON.stringify(checksums, null, 2)}\n`);
        syncDirectory(staging);
        // The same check a restore runs; only a package that passes it is published.
        if (!verifyDatabaseSnapshot(staging).ok) {
          return { ok: false, code: "SNAPSHOT_FAILED" };
        }
        renameSync(staging, path.join(options.backupsDir, name));
        staging = undefined;
        syncDirectory(root);
        syncDirectory(options.backupsDir);
        return { ok: true, snapshotId };
      } catch {
        return { ok: false, code: "SNAPSHOT_FAILED" };
      } finally {
        if (staging !== undefined) {
          rmSync(staging, { recursive: true, force: true });
        }
      }
    },
  };
}
