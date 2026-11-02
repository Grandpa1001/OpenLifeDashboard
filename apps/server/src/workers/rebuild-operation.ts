// A change of a registry's structure as an operation of the maintenance gate (Architektura §4.8,
// §11.4, §18.4; D27.2, D28.2, D29.1). The gate records the operation `rebuild` (the registry and the
// schema revision it starts from) before the database changes and closes it after, under the writer
// lease the process holds, so the server, the CLI and a later worker share one exclusivity: a CLI
// started meanwhile meets the lease (INSTANCE_BUSY), and a crash leaves the operation for the
// bootstrap to reconcile from the registry (bootstrap/database.ts). Every change of the structure
// raises the schema revision by one in one transaction, so the same reconciliation holds for the
// rebuild of a table (D27) and the DDL of a column (D28). The work is one unit on the writer
// connection of this process, as the measurement of D27.1 allows for P0 (no worker thread, no
// handoff of the writer).
//
// A change of type (the route passes `pre_type_change`) first takes a verified copy of the database (`pre_type_change`, §5.2, §11.3.1) in
// the phase `snapshot`; no copy, no change. The copy is asynchronous, so other requests run while it is
// made: a change of the structure meets the active operation (MAINTENANCE), and a record written
// meanwhile raises the data revision of the registry, so the plan checked under the writer is stale
// and nothing is rebuilt. A rebuild that runs therefore finds the registry exactly as the copy has it.
import type { MaintenanceOperation } from "@openlife/contracts/workers/maintenance-state";
import type { Commit, ReadUnit, Result, UnitOfWork } from "@openlife/core/foundation";
import type { DatabaseSnapshotPort, SnapshotRequest } from "@openlife/core/maintenance";
import type { RegistryStore } from "@openlife/core/registries";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";

type OperationPorts = Readonly<{ registries: Pick<RegistryStore, "find"> }>;

export type StructureOperationDependencies<P extends OperationPorts> = Readonly<{
  gate: MaintenanceGate;
  unit: UnitOfWork<P> & ReadUnit<P>;
  /** The copies of the database this process takes through its writer connection. */
  snapshots: Pick<DatabaseSnapshotPort, "create">;
  nowMs: () => number;
  newOperationId: () => string;
}>;

/** The copy a change takes before its unit, or none (the changes of a column, §11.3.1). */
export type StructureCopy = SnapshotRequest["reason"] | null;

/** What the work committed, and the copy taken before it (null for a change without one). */
export type StructureOutcome<T> = Readonly<{ value: T; snapshotId: string | null }>;

/** Runs the work of one change of a registry's structure inside an operation of the gate; an unknown registry begins no operation. */
export function createStructureOperation<P extends OperationPorts>(deps: StructureOperationDependencies<P>) {
  return async <T>(target: Readonly<{ ownerId: string; symbol: string }>, work: (ports: P, nowMs: number) => Commit<T>, copy: StructureCopy = null): Promise<Result<StructureOutcome<T>>> => {
    const registry = deps.unit.read((ports) => ports.registries.find(target.ownerId, target.symbol));
    if (registry === null || registry.deletedAt !== null) return { ok: false, error: { code: "NOT_FOUND" } };
    // No await between this check and `begin`: another request cannot begin an operation in between.
    if (deps.gate.current().activeOperation !== null) return { ok: false, error: { code: "MAINTENANCE" } };
    const nowMs = deps.nowMs();
    const base = {
      operationId: deps.newOperationId(),
      reason: "rebuild",
      startedAt: new Date(nowMs).toISOString(),
      registryId: registry.id,
      fromSchemaRevision: registry.schemaRevision,
    } as const;
    const begun: MaintenanceOperation = copy === null ? { ...base, phase: "rebuilding" } : { ...base, phase: "snapshot", snapshotId: null };
    const { generation } = deps.gate.begin(begun);
    // The unit commits or rolls back as a whole and a failed copy changes nothing, so the operation
    // closes either way; a failure to close it leaves it active, and the next start reconciles it.
    try {
      let snapshotId: string | null = null;
      if (copy !== null) {
        const snapshot = await deps.snapshots.create({ reason: copy, scope: "database", operationId: base.operationId, fence: generation });
        if (!snapshot.ok) return { ok: false, error: { code: snapshot.code === "SNAPSHOT_LOW_SPACE" ? "SNAPSHOT_LOW_SPACE" : "SNAPSHOT_FAILED" } };
        snapshotId = snapshot.snapshotId;
        deps.gate.advance({ ...base, phase: "rebuilding", snapshotId });
      }
      const result = deps.unit.run((ports) => work(ports, nowMs));
      return result.ok ? { ok: true, value: { value: result.value.value, snapshotId } } : result;
    } finally {
      deps.gate.complete(base.operationId, generation);
    }
  };
}
