// The app's side of an update up to the switch (Architektura §11.2.2 steps 1 to 4; D54.4). It starts the operation at the
// updater, waits while the updater pulls the images (A serves meanwhile), closes the writes and waits for those in flight
// (`quiesce`), tells the updater the app is quiet, takes the `pre_update` copy itself (the updater holds the backups
// read-only) and tells the updater its name; the updater checks it and enters `switching`, where this step ends (the
// switch is D55). Any failure before that point asks the updater to give the operation up, opens the writes again and leaves
// the reason in the state, so A is as it was. A second start while one is going is refused, and the same operation asked
// again is the same operation. The truth about where the operation is lives in the journal of the updater; what the app
// keeps in memory is only which run it is driving.
import type { UpdatesStatusDto } from "@openlife/contracts/http/updates";
import type { DatabaseSnapshotPort } from "@openlife/core/maintenance";
import type { UpdaterClient } from "../adapters/updates/updater-client.js";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { UPDATE_PULL_TIMEOUT_MS, UPDATE_STATUS_POLL_MS } from "./update-limits.js";
import type { createUpdateOperation } from "./update-operation.js";

export type StartRefusal = "NOT_CONFIGURED" | "RELEASE_UNKNOWN" | "IN_PROGRESS" | "MAINTENANCE" | "UPDATER_REFUSED" | "UPDATER_UNAVAILABLE";
export type StartResult = Readonly<{ ok: true; operationId: string; resumed: boolean }> | Readonly<{ ok: false; code: StartRefusal; detail: string | null }>;
export type UpdateOperationState = NonNullable<UpdatesStatusDto["operation"]>;

/** What the routes use: nothing of how an update is driven. */
export type UpdateInstaller = Readonly<{
  /** The refusal a start would meet before anything is asked of the updater, or null. */
  refusalFor: (release: string, operationId: string | undefined) => StartRefusal | null;
  /** True when the operation is the one in hand, so asking for it again starts nothing new. */
  resumes: (operationId: string | undefined) => boolean;
  start: (release: string, operationId?: string) => Promise<StartResult>;
  /** The operation as the journal of the updater has it. */
  operation: () => Promise<UpdateOperationState | null>;
}>;

/** An installation with no updater: nothing can be started and there is no operation. */
export const unconfiguredInstaller: UpdateInstaller = {
  refusalFor: () => "NOT_CONFIGURED",
  resumes: () => false,
  start: async () => ({ ok: false, code: "NOT_CONFIGURED", detail: null }),
  operation: async () => null,
};

export type UpdateCoordinatorDependencies = Readonly<{
  updater: UpdaterClient;
  gate: Pick<MaintenanceGate, "current">;
  operation: ReturnType<typeof createUpdateOperation>;
  snapshots: Pick<DatabaseSnapshotPort, "create">;
  /** The name of the published package of a snapshot in the backup folder, or null when there is none. */
  packageOf: (snapshotId: string) => string | null;
  /** The release the last check found available, or null. */
  availableRelease: () => string | null;
  newOperationId: () => string;
  logger: Pick<TechnicalLogger, "log">;
  pollMs?: number;
  pullTimeoutMs?: number;
}>;

export type UpdateCoordinator = UpdateInstaller & Readonly<{
  /** Resolves when the run in hand has ended, whatever it ended in. */
  settled: () => Promise<void>;
  /** The run in hand or the last one: where the app has taken it, and why it stopped. */
  progress: () => Readonly<{ operationId: string; release: string; phase: "pulling" | "quiescing" | "backing_up" | "switching" | "failed"; code: string | null }> | null;
}>;

type Run = { operationId: string; release: string; phase: "pulling" | "quiescing" | "backing_up" | "switching" | "failed"; code: string | null; finished: boolean; done: Promise<void> };

export function createUpdateCoordinator(deps: UpdateCoordinatorDependencies): UpdateCoordinator {
  let run: Run | null = null;
  const pollMs = deps.pollMs ?? UPDATE_STATUS_POLL_MS;
  const pullTimeoutMs = deps.pullTimeoutMs ?? UPDATE_PULL_TIMEOUT_MS;
  const log = (event: string, operationId: string, code?: string): void => deps.logger.log({ level: code === undefined ? "info" : "warn", event, ...(code === undefined ? {} : { code }), operationId });

  const refusalFor = (release: string, operationId: string | undefined): StartRefusal | null => {
    if (run !== null && !run.finished) return operationId !== undefined && operationId === run.operationId ? null : "IN_PROGRESS";
    if (run !== null && run.phase === "switching") return operationId !== undefined && operationId === run.operationId ? null : "IN_PROGRESS";
    if (deps.availableRelease() !== release) return "RELEASE_UNKNOWN";
    if (deps.gate.current().activeOperation !== null) return "MAINTENANCE";
    return null;
  };

  async function drive(current: Run, fence: number): Promise<void> {
    const operationId = current.operationId;
    let gateFence: number | null = null;
    /** Gives the operation up: the updater is asked to close it (it answers as done when it already has), the writes open again, the reason stays. */
    const fail = async (code: string, giveUp: boolean): Promise<void> => {
      if (giveUp) await deps.updater.send({ type: "abort", fence }, operationId).catch(() => undefined);
      if (gateFence !== null) {
        try {
          deps.operation.reopen(operationId, gateFence);
        } catch {
          deps.logger.log({ level: "error", event: "update.reopen_failed", code: "REOPEN_FAILED", operationId });
        }
      }
      current.phase = "failed";
      current.code = code;
      log("update.failed", operationId, code);
    };
    // 1. The updater pulls; the app waits and serves.
    const deadline = Date.now() + pullTimeoutMs;
    for (;;) {
      const status = await deps.updater.status();
      if (status !== null && status.operationId === operationId) {
        if (status.state === "quiescing") break;
        if (status.state === "idle") return fail(status.error?.code ?? "UPDATER_CLOSED", false);
      } else if (status !== null && status.operationId !== operationId) {
        return fail("OPERATION_REPLACED", false);
      }
      if (Date.now() > deadline) return fail("PULL_TIMEOUT", false);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    // 2. The app closes its writes and waits for those in flight.
    current.phase = "quiescing";
    const quiet = await deps.operation.quiesce(current.release, operationId);
    if (!quiet.ok) return fail(quiet.code, true);
    gateFence = quiet.fence;
    if (quiet.fence !== fence) return fail("FENCE_CHANGED", true);
    const told = await deps.updater.send({ type: "quiesced", fence }, operationId);
    if (told.kind !== "accepted") return fail(told.kind === "refused" ? told.code : "UPDATER_UNAVAILABLE", true);
    // 3. The copy, taken here: the updater only looks at it.
    current.phase = "backing_up";
    deps.operation.enter("backing_up");
    const snapshot = await deps.snapshots.create({ reason: "pre_update", scope: "database", operationId, fence });
    if (!snapshot.ok) return fail(snapshot.code, true);
    const name = deps.packageOf(snapshot.snapshotId);
    if (name === null) return fail("SNAPSHOT_FAILED", true);
    const backedUp = await deps.updater.send({ type: "backed_up", backupId: name, fence }, operationId);
    if (backedUp.kind !== "accepted") return fail(backedUp.kind === "refused" ? backedUp.code : "UPDATER_UNAVAILABLE", true);
    // 4. The updater is in `switching`; the app records it and waits, closed, for the switch.
    deps.operation.enter("switching");
    current.phase = "switching";
    log("update.switching", operationId);
  }

  return {
    refusalFor,
    resumes: (operationId) => run !== null && operationId !== undefined && run.operationId === operationId,
    start: async (release, requested) => {
      const refusal = refusalFor(release, requested);
      if (refusal !== null) return { ok: false, code: refusal, detail: null };
      if (run !== null && requested !== undefined && run.operationId === requested) return { ok: true, operationId: run.operationId, resumed: true };
      const operationId = requested ?? deps.newOperationId();
      // The fence the gate will hold once this operation is on it; if another operation takes the generation first, the app notices and gives up.
      const fence = deps.gate.current().generation + 1;
      const answer = await deps.updater.send({ type: "install", release, fence }, operationId);
      if (answer.kind === "unreachable") return { ok: false, code: "UPDATER_UNAVAILABLE", detail: null };
      if (answer.kind === "refused") return { ok: false, code: "UPDATER_REFUSED", detail: answer.code };
      const current: Run = { operationId, release, phase: "pulling", code: null, finished: false, done: Promise.resolve() };
      run = current;
      current.done = drive(current, fence)
        .catch((error: unknown) => {
          current.phase = "failed";
          current.code = "UPDATE_FAILED";
          deps.logger.log({ level: "error", event: "update.run_failed", code: "UPDATE_FAILED", operationId, error });
        })
        .finally(() => {
          current.finished = true;
        });
      return { ok: true, operationId, resumed: false };
    },
    operation: async () => {
      const status = await deps.updater.status();
      if (status === null || status.operationId === null) return null;
      return { operationId: status.operationId, state: status.state, targetRelease: status.targetRelease, error: status.error };
    },
    settled: () => run?.done ?? Promise.resolve(),
    progress: () => (run === null ? null : { operationId: run.operationId, release: run.release, phase: run.phase, code: run.code }),
  };
}
