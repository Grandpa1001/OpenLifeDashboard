import { z } from "zod";

// Snapshot packages (Architektura §11.3.1, §11.4). Scope `database` is a directory with exactly
// app.db, meta.json and checksums.json. Scope `bundle` (D48) adds export.json, made from the copy of
// the database itself, so both describe one state. The checksums detect damage; they are not a
// signature or an authorization.

export const DATABASE_SNAPSHOT_META_VERSION = 1;

/** Files of a complete package; anything else (e.g. -wal/-shm) makes it invalid. */
export const DATABASE_SNAPSHOT_FILES = { database: "app.db", meta: "meta.json", checksums: "checksums.json" } as const;
/** The extra file of a `bundle`: the export document of the same state as app.db. */
export const BUNDLE_EXPORT_FILE = "export.json";
export const SNAPSHOT_SCOPES = ["database", "bundle"] as const;
export type SnapshotScope = (typeof SNAPSHOT_SCOPES)[number];

/** The files a package of this scope holds, sorted; anything else (e.g. -wal/-shm) makes it invalid. */
export function snapshotFilesOf(scope: SnapshotScope): string[] {
  return [...Object.values(DATABASE_SNAPSHOT_FILES), ...(scope === "bundle" ? [BUNDLE_EXPORT_FILE] : [])].sort();
}

export const SNAPSHOT_REASONS = ["nightly", "manual", "pre_update", "pre_delete", "pre_type_change", "pre_migration", "pre_restore"] as const;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const metaFields = {
  metaVersion: z.literal(DATABASE_SNAPSHOT_META_VERSION),
  snapshotId: z.uuid(),
  operationId: z.uuid(),
  instanceId: z.uuid(),
  reason: z.enum(SNAPSHOT_REASONS),
  appVersion: z.string().min(1),
  /** Source revision of the image; required even when no published digest exists (local images). */
  buildRevision: z.string().min(1),
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  schemaVersion: z.int().min(1),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  databaseBytes: z.int().min(1),
  /** Auth data in the copy can be used only with the installation's original keys. */
  requiresOriginalKeys: z.literal(true),
};

export const databaseSnapshotMetaSchema = z.object({ ...metaFields, scope: z.literal("database") }).strict();
/** A bundle names the format version of its export.json; the scope `database` has none. */
export const bundleSnapshotMetaSchema = z.object({ ...metaFields, scope: z.literal("bundle"), formatVersion: z.int().min(1) }).strict();
export const snapshotMetaSchema = z.discriminatedUnion("scope", [databaseSnapshotMetaSchema, bundleSnapshotMetaSchema]);

const databaseChecksumFiles = { [DATABASE_SNAPSHOT_FILES.database]: sha256Hex, [DATABASE_SNAPSHOT_FILES.meta]: sha256Hex };
export const databaseSnapshotChecksumsSchema = z.object({ algorithm: z.literal("sha256"), files: z.object(databaseChecksumFiles).strict() }).strict();
export const bundleSnapshotChecksumsSchema = z
  .object({ algorithm: z.literal("sha256"), files: z.object({ ...databaseChecksumFiles, [BUNDLE_EXPORT_FILE]: sha256Hex }).strict() })
  .strict();

export type DatabaseSnapshotMeta = z.infer<typeof databaseSnapshotMetaSchema>;
export type BundleSnapshotMeta = z.infer<typeof bundleSnapshotMetaSchema>;
export type SnapshotMeta = z.infer<typeof snapshotMetaSchema>;
export type DatabaseSnapshotChecksums = z.infer<typeof databaseSnapshotChecksumsSchema>;
export type BundleSnapshotChecksums = z.infer<typeof bundleSnapshotChecksumsSchema>;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/**
 * Input of `restore-registry` (D30.2) on stdin: the name of a published package directory in the
 * backup folder (UTC start, reason and snapshot ID, as the store names it) and the symbol of the
 * registry to restore from it. A name, never a path: the command finds the package in its own folder.
 */
export const restoreRegistryInputSchema = z
  .object({
    snapshot: z.string().regex(/^\d{8}T\d{6}Z-[a-z_]+-[0-9a-f-]{36}$/),
    symbol: z.string().min(1).max(64),
  })
  .strict();
export type RestoreRegistryInput = z.infer<typeof restoreRegistryInputSchema>;

/** Input of `backup-verify` (D50.1) on stdin: the name of a package in the backup folder, never a path. */
export const backupVerifyInputSchema = z.object({ snapshot: restoreRegistryInputSchema.shape.snapshot }).strict();
export type BackupVerifyInput = z.infer<typeof backupVerifyInputSchema>;

/**
 * Input of `restore-instance` (D50.2) on stdin: the package to restore and the explicit confirmation that the
 * current database is to be replaced (it is moved aside, not deleted, but the instance changes under the owner).
 */
export const RESTORE_INSTANCE_CONFIRMATION = "replace-current-database";
export const restoreInstanceInputSchema = z.object({ snapshot: restoreRegistryInputSchema.shape.snapshot, confirm: z.literal(RESTORE_INSTANCE_CONFIRMATION) }).strict();
export type RestoreInstanceInput = z.infer<typeof restoreInstanceInputSchema>;
