import { z } from "zod";

// Snapshot package of scope `database` (Architektura §11.3.1, §11.4): a directory with exactly
// app.db, meta.json and checksums.json. It needs no export.json (that is scope `bundle`, D48).
// The checksums detect damage; they are not a signature or an authorization.

export const DATABASE_SNAPSHOT_META_VERSION = 1;

/** Files of a complete package; anything else (e.g. -wal/-shm) makes it invalid. */
export const DATABASE_SNAPSHOT_FILES = { database: "app.db", meta: "meta.json", checksums: "checksums.json" } as const;

export const SNAPSHOT_REASONS = ["nightly", "pre_update", "pre_delete", "pre_type_change", "pre_migration", "pre_restore"] as const;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const databaseSnapshotMetaSchema = z
  .object({
    metaVersion: z.literal(DATABASE_SNAPSHOT_META_VERSION),
    scope: z.literal("database"),
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
  })
  .strict();

export const databaseSnapshotChecksumsSchema = z
  .object({
    algorithm: z.literal("sha256"),
    files: z.object({ [DATABASE_SNAPSHOT_FILES.database]: sha256Hex, [DATABASE_SNAPSHOT_FILES.meta]: sha256Hex }).strict(),
  })
  .strict();

export type DatabaseSnapshotMeta = z.infer<typeof databaseSnapshotMetaSchema>;
export type DatabaseSnapshotChecksums = z.infer<typeof databaseSnapshotChecksumsSchema>;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];
