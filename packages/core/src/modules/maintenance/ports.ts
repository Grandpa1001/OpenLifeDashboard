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
}
