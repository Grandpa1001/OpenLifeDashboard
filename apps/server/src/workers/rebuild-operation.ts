// A change of a registry's structure as an operation of the maintenance gate (Architektura §4.8,
// §11.4, §18.4; D27.2, D28.2). The gate records the operation `rebuild` (the registry and the schema
// revision it starts from) before the database changes and closes it after, under the writer lease the
// process holds, so the server, the CLI and a later worker share one exclusivity: a CLI started
// meanwhile meets the lease (INSTANCE_BUSY), and a crash leaves the operation for the bootstrap to
// reconcile from the registry (bootstrap/database.ts). Every change of the structure raises the
// schema revision by one in one transaction, so the same reconciliation holds for the rebuild of a
// table (D27) and the DDL of a column (D28). The work is one unit on the writer connection of this
// process, as the measurement of D27.1 allows for P0 (no worker thread, no handoff of the writer).
import type { MaintenanceOperation } from "@openlife/contracts/workers/maintenance-state";
import type { Commit, ReadUnit, Result, UnitOfWork } from "@openlife/core/foundation";
import { changeColumnType, type RegistryStore, type TypeChanged, type TypeChangeDependencies, type TypeChangeInput, type TypeChangePorts } from "@openlife/core/registries";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";

type OperationPorts = Readonly<{ registries: Pick<RegistryStore, "find"> }>;

export type StructureOperationDependencies<P extends OperationPorts> = Readonly<{
  gate: MaintenanceGate;
  unit: UnitOfWork<P> & ReadUnit<P>;
  nowMs: () => number;
  newOperationId: () => string;
}>;

/** Runs the work of one change of a registry's structure inside an operation of the gate; an unknown registry begins no operation. */
export function createStructureOperation<P extends OperationPorts>(deps: StructureOperationDependencies<P>) {
  return <T>(target: Readonly<{ ownerId: string; symbol: string }>, work: (ports: P, nowMs: number) => Commit<T>): Result<T> => {
    const registry = deps.unit.read((ports) => ports.registries.find(target.ownerId, target.symbol));
    if (registry === null || registry.deletedAt !== null) return { ok: false, error: { code: "NOT_FOUND" } };
    const nowMs = deps.nowMs();
    const operation: MaintenanceOperation = {
      operationId: deps.newOperationId(),
      reason: "rebuild",
      phase: "rebuilding",
      startedAt: new Date(nowMs).toISOString(),
      registryId: registry.id,
      fromSchemaRevision: registry.schemaRevision,
    };
    const { generation } = deps.gate.begin(operation);
    // The unit commits or rolls back as a whole, so the operation closes either way; a failure to
    // close it leaves it active, and the next start reconciles it from the registry.
    try {
      const result = deps.unit.run((ports) => work(ports, nowMs));
      return result.ok ? { ok: true, value: result.value.value } : result;
    } finally {
      deps.gate.complete(operation.operationId, generation);
    }
  };
}

export type RebuildOperationDependencies = StructureOperationDependencies<TypeChangePorts> & Readonly<{ change: Omit<TypeChangeDependencies, "nowMs"> }>;

/** The rebuild of a table for a change of a column's type (D27.2); the route of D29 calls it. */
export function createRebuildOperation(deps: RebuildOperationDependencies): (input: TypeChangeInput) => Result<TypeChanged> {
  const operation = createStructureOperation(deps);
  return (input) => operation(input, (ports, nowMs) => changeColumnType(ports, { ...deps.change, nowMs }, input));
}
