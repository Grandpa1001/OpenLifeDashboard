// The update as an operation of the maintenance gate (Architektura §4.8, §11.2.2 steps 2 and 3; D54.3). `quiesce` records
// the operation `update` on the gate (which refuses every write from that moment, the gate's generation being the fence the
// updater is told) and then waits for the writes the app had already taken; only when they have ended does it say the app
// is quiet. A wait that runs out opens the writes again and says so, since an update that cannot be quiet must not hold the
// installation. The later phases are recorded before the work of each, so a crash leaves the phase that was reached. Closing
// an operation that has not switched is `reopen`; the operations after the switch are D55 and D56.
import type { MaintenanceOperation } from "@openlife/contracts/workers/maintenance-state";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";
import type { UpdateBarrier } from "../http/middleware/update-barrier.js";

type UpdateOperation = Extract<MaintenanceOperation, { reason: "update" }>;
export type UpdatePhase = UpdateOperation["phase"];

export type UpdateOperationDependencies = Readonly<{
  gate: Pick<MaintenanceGate, "current" | "begin" | "advance" | "complete">;
  barrier: Pick<UpdateBarrier, "drain">;
  nowMs: () => number;
  newOperationId: () => string;
  /** How long the writes already taken may take to end. */
  drainTimeoutMs: number;
}>;

export type QuiesceResult =
  | Readonly<{ ok: true; operationId: string; fence: number }>
  | Readonly<{ ok: false; code: "MAINTENANCE" | "DRAIN_TIMEOUT" }>;

export function createUpdateOperation(deps: UpdateOperationDependencies) {
  const operationOf = (operationId: string, targetRelease: string, startedAt: string, phase: UpdatePhase): UpdateOperation => ({ operationId, reason: "update", phase, startedAt, targetRelease });
  return {
    /** Another operation holds the gate: nothing is begun. Otherwise writes are refused now and the answer waits for those in flight. */
    async quiesce(targetRelease: string, operationId: string = deps.newOperationId()): Promise<QuiesceResult> {
      // No await between this look and `begin`: another request cannot begin an operation in between.
      if (deps.gate.current().activeOperation !== null) return { ok: false, code: "MAINTENANCE" };
      const startedAt = new Date(deps.nowMs()).toISOString();
      const { generation } = deps.gate.begin(operationOf(operationId, targetRelease, startedAt, "quiescing"));
      if (await deps.barrier.drain(deps.drainTimeoutMs)) return { ok: true, operationId, fence: generation };
      deps.gate.complete(operationId, generation);
      return { ok: false, code: "DRAIN_TIMEOUT" };
    },
    /** Records the phase to be reached before its work; only the active update operation can be advanced. */
    enter(phase: Exclude<UpdatePhase, "quiescing">): void {
      const active = deps.gate.current().activeOperation;
      if (active === null || active.reason !== "update") throw new Error("no update operation is active");
      deps.gate.advance({ ...active, phase });
    },
    /** The operation ends before the switch: A was not touched, so the writes open again. Another operation or generation is refused by the gate. */
    reopen(operationId: string, fence: number): void {
      deps.gate.complete(operationId, fence);
    },
  };
}
