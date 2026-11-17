// The new app B after it has taken over the operation of the update (Architektura §11.2.2 steps 6 and 7; D55.2). It is up, the
// database is migrated, and writes are still closed by the gate and its readiness is held: "the process lives" is no evidence. It reads
// its own database, tells the updater it is ready (version of the application and of the schema, which the updater compares with the
// release and not with this process), and waits for the updater to say that the commit point is passed. Only then is the operation closed
// on the gate and the readiness given back, so the writes open after a choice that is durable and not before. A proof that is refused or
// cannot be made, a commit that does not come, or an operation that is not the one asked about leave the app closed, with the reason in
// the log: the way back is the updater's (D56).
import type { UpdaterClient } from "../adapters/updates/updater-client.js";
import type { MaintenanceGate } from "../adapters/filesystem/maintenance-gate.js";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import type { AdoptedUpdate } from "../bootstrap/database.js";
import type { ReadinessControl } from "../bootstrap/readiness.js";
import { UPDATE_COMMIT_POLL_MS, UPDATE_COMMIT_WAIT_MS } from "./update-limits.js";

export type AdoptionOutcome = "committed" | "failed" | "stopped";

export type UpdateAdoptionDependencies = Readonly<{
  updater: Pick<UpdaterClient, "send" | "status">;
  gate: Pick<MaintenanceGate, "complete">;
  readiness: Pick<ReadinessControl, "release">;
  /** Reads what the new app depends on (the database, its integrity); false or a throw is a failed proof. */
  selfCheck: () => boolean;
  appVersion: string;
  schemaVersion: number;
  update: AdoptedUpdate;
  logger: Pick<TechnicalLogger, "log">;
  pollMs?: number;
  waitMs?: number;
  /** Tells the open tabs that the operation is over for this app (D57.3); the fact and nothing else. */
  announce?: () => void;
}>;

export type UpdateAdoption = Readonly<{ run: () => Promise<AdoptionOutcome>; stop: () => void }>;

export function createUpdateAdoption(deps: UpdateAdoptionDependencies): UpdateAdoption {
  let stopped = false;
  const { operationId, fence } = deps.update;
  const log = (event: string, code?: string): void => deps.logger.log({ level: code === undefined ? "info" : "warn", event, ...(code === undefined ? {} : { code }), operationId });
  const failed = (code: string): AdoptionOutcome => {
    log("update.adoption_failed", code);
    return "failed";
  };
  return {
    stop: () => {
      stopped = true;
    },
    run: async () => {
      let proven: boolean;
      try {
        proven = deps.selfCheck();
      } catch {
        proven = false;
      }
      if (!proven) return failed("SELF_CHECK_FAILED");
      const told = await deps.updater.send({ type: "ready", fence, appVersion: deps.appVersion, schemaVersion: deps.schemaVersion }, operationId);
      if (told.kind !== "accepted") return failed(told.kind === "refused" ? told.code : "UPDATER_UNAVAILABLE");
      const deadline = Date.now() + (deps.waitMs ?? UPDATE_COMMIT_WAIT_MS);
      while (!stopped) {
        const status = await deps.updater.status();
        if (status !== null && status.operationId === operationId && status.committed) {
          // The choice is durable: the operation ends on the gate and the writes open, in this order.
          deps.gate.complete(operationId, fence);
          deps.readiness.release();
          log("update.adopted");
          try {
            deps.announce?.();
          } catch {
            // The stream is a convenience; the state is the truth.
          }
          return "committed";
        }
        if (status !== null && (status.operationId !== operationId || status.state === "idle" || status.state === "rolling_back" || status.state === "rolled_back" || status.state === "recovery_failed")) return failed("OPERATION_ENDED");
        if (Date.now() > deadline) return failed("COMMIT_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? UPDATE_COMMIT_POLL_MS));
      }
      return "stopped";
    },
  };
}
