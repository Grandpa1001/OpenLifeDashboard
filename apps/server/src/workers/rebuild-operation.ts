// The rebuild of a registry's table as an operation of the maintenance gate (Architektura §4.8,
// §11.4, §18.4; D27.2). The gate records the operation before the database changes and closes it
// after, under the writer lease the process holds, so the server, the CLI and a later worker share one
// exclusivity: a CLI started meanwhile meets the lease (INSTANCE_BUSY), and a crash leaves the
// operation for the bootstrap to reconcile from the registry (bootstrap/database.ts). The work is the
// one unit of `changeColumnType`; it runs on the writer connection of this process, as the
// measurement of D27.1 allows for P0 (no worker thread, no handoff of the writer).
import type { MaintenanceOperation } from "@openlife/contracts/workers/maintenance-state";
import type { ReadUnit, Result, UnitOfWork } from "@openlife/core/foundation";
import { changeColumnType, type TypeChanged, type TypeChangeDependencies, type TypeChangeInput, type TypeChangePorts } from "@openlife/core/registries";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";

export type RebuildOperationDependencies = Readonly<{
  gate: MaintenanceGate;
  unit: UnitOfWork<TypeChangePorts> & ReadUnit<TypeChangePorts>;
  change: Omit<TypeChangeDependencies, "nowMs">;
  nowMs: () => number;
  newOperationId: () => string;
}>;

export function createRebuildOperation(deps: RebuildOperationDependencies): (input: TypeChangeInput) => Result<TypeChanged> {
  return (input) => {
    const registry = deps.unit.read((ports) => ports.registries.find(input.ownerId, input.symbol));
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
      const result = deps.unit.run((ports) => changeColumnType(ports, { ...deps.change, nowMs }, input));
      return result.ok ? { ok: true, value: result.value.value } : result;
    } finally {
      deps.gate.complete(operation.operationId, generation);
    }
  };
}
