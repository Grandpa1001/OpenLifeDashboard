// Ports of the maintenance module (Architektura §11.4, §18.4).

export type SnapshotRequest = Readonly<{
  reason: "pre_migration";
  scope: "database";
  /** The maintenance operation the snapshot belongs to and its fence (gate generation). */
  operationId: string;
  fence: number;
}>;

export type SnapshotResult =
  | Readonly<{ ok: true; snapshotId: string }>
  | Readonly<{ ok: false; code: "SNAPSHOT_UNAVAILABLE" | "SNAPSHOT_LOW_SPACE" | "SNAPSHOT_FAILED" }>;

/**
 * Creates a verified `database` snapshot of the source under the writer lease (D05). It runs
 * before and outside any unit of work; no snapshot means no migration of an existing database.
 */
export interface DatabaseSnapshotPort {
  create(request: SnapshotRequest): Promise<SnapshotResult>;
  /**
   * The published snapshot that belongs to this operation, verified again now (crash after
   * publication, D05.3). A package that does not verify, or a leftover of staging, is never
   * returned: only a published and valid snapshot counts as completed.
   */
  findPublished(operationId: string): Promise<PublishedSnapshot | undefined>;
  /** Removes working directories of snapshots that were never published (crash while staging). */
  discardUnpublished(): Promise<void>;
}

export type PublishedSnapshot = Readonly<{
  snapshotId: string;
  /** schemaVersion of the database at the time of the snapshot. */
  schemaVersion: number;
}>;
