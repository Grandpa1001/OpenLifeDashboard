// DatabaseSnapshotPort on the installation's backup folder (Architektura §11.3.1, §11.4; D05.1).
// A snapshot is built in data/backup/.staging/<name>, checked there in full and only then
// published by a rename into data/backup/<name> on the same mount: a published directory is a
// verified package, a staging directory never is. The caller holds the writer lease; the copy
// is read through the writer connection (Backup API), never by copying the database file.
// Recovery of staging left by a crash and real disk-full handling are D05.3.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import path from "node:path";
import {
  DATABASE_SNAPSHOT_FILES,
  DATABASE_SNAPSHOT_META_VERSION,
  databaseSnapshotChecksumsSchema,
  databaseSnapshotMetaSchema,
  type DatabaseSnapshotChecksums,
  type DatabaseSnapshotMeta,
} from "@openlife/contracts/backups/database-snapshot";
import type { DatabaseSnapshotPort, SnapshotResult } from "@openlife/core/maintenance";
import type { SqliteConnection } from "@openlife/sqlite/connection";
import { copyDatabase, examineDatabaseCopy } from "@openlife/sqlite/snapshots";
import { syncDirectory, syncFile, writeNewFileDurably } from "./durable-files.js";

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
}>;

export type SnapshotVerification =
  | Readonly<{ ok: true; meta: DatabaseSnapshotMeta }>
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
  const expectedFiles = Object.values(DATABASE_SNAPSHOT_FILES).sort();
  const present = readdirSync(dir).sort();
  const regular = present.every((name) => lstatSync(path.join(dir, name)).isFile());
  if (JSON.stringify(present) !== JSON.stringify(expectedFiles) || !regular) {
    return invalid("files");
  }
  const at = (name: string): string => path.join(dir, name);
  const checksums = databaseSnapshotChecksumsSchema.safeParse(readJson(at(DATABASE_SNAPSHOT_FILES.checksums)));
  if (!checksums.success) {
    return invalid(DATABASE_SNAPSHOT_FILES.checksums);
  }
  const changed = [DATABASE_SNAPSHOT_FILES.database, DATABASE_SNAPSHOT_FILES.meta].filter(
    (name) => sha256File(at(name)) !== checksums.data.files[name],
  );
  if (changed.length > 0) {
    return invalid(...changed);
  }
  const meta = databaseSnapshotMetaSchema.safeParse(readJson(at(DATABASE_SNAPSHOT_FILES.meta)));
  if (!meta.success) {
    return invalid(DATABASE_SNAPSHOT_FILES.meta);
  }
  const copy = examineDatabaseCopy(at(DATABASE_SNAPSHOT_FILES.database));
  if (!copy.ok) {
    return invalid(copy.problem);
  }
  const disagreeing = [
    copy.facts.schemaVersion === meta.data.schemaVersion ? [] : ["schemaVersion"],
    copy.facts.instanceId === meta.data.instanceId ? [] : ["instanceId"],
    copy.facts.bytes === meta.data.databaseBytes ? [] : ["databaseBytes"],
  ].flat();
  return disagreeing.length > 0 ? invalid(...disagreeing) : { ok: true, meta: meta.data };
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
    async create(request): Promise<SnapshotResult> {
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
        const meta: DatabaseSnapshotMeta = {
          metaVersion: DATABASE_SNAPSHOT_META_VERSION,
          scope: "database",
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
        };
        const metaFile = path.join(staging, DATABASE_SNAPSHOT_FILES.meta);
        writeNewFileDurably(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
        const checksums: DatabaseSnapshotChecksums = {
          algorithm: "sha256",
          files: { [DATABASE_SNAPSHOT_FILES.database]: sha256File(databaseFile), [DATABASE_SNAPSHOT_FILES.meta]: sha256File(metaFile) },
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
