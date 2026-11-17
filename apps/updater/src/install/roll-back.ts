// The way back to the app A (Architektura §11.2.2 "Awaria przed commit point", §11.3.3; D56.1). It begins where an operation stops in
// `rolling_back` after the switch has been made or tried, and it ends with the app A running on the database of the copy taken before
// the update, the release file as it was, the gate holding no operation and the operation `idle` with the code that stopped it, or in
// `recovery_failed` with writes closed, never anything between. The order is the one that keeps the image and the data a pair:
//   1. every app of the project is stopped and the new one is removed, the old one gets its name again (no start);
//   2. the helper of the recovery, made from the image of the old app, restores the database from the copy `pre_update` and, under the
//      same lease, ends the operation on the gate (so the old app finds a quiet gate and needs no reconciliation of its own);
//   3. the release file is put back as it was before the operation (or removed when there was none);
//   4. the old app is started and waited for until it is healthy, and only then `rolled_back` is written and the operation ends `idle`.
// The copy is always restored: no write was taken since it, so nothing is lost, and the access of the old sessions is ended (D50.2).
// Every step looks first, so the same way back can be made again after a crash (D56.2). A failure of any step is `recovery_failed`
// with the code of the step: the data and the copy stay, the gate stays closed, and only the operator closes it.
import { ScopeError, type ProjectScope } from "../docker/project-scope.js";
import type { Journal } from "../journal/journal.js";
import type { UpdaterLogger } from "../logging.js";
import { restoreReleaseFile } from "../release/release-file.js";
import { transition } from "../state-machine/transitions.js";
import type { UpdateRecord } from "@openlife/contracts/updates/state";

/** How long the old app has to be healthy again before the way back is called a failure. */
export const ROLLBACK_HEALTH_TIMEOUT_MS = 120 * 1000;

export type RollbackOptions = Readonly<{
  journal: Journal;
  controlDir: string;
  scope: Pick<ProjectScope, "findApp" | "stopApp" | "startApp" | "retireReplacement" | "retireOthers" | "imageOfApp" | "isRunning" | "runRecovery" | "waitHealthy">;
  nowIso: () => string;
  logger: UpdaterLogger;
  healthTimeoutMs?: number;
}>;

export type RollbackRunner = Readonly<{ run: (record: UpdateRecord) => Promise<void> }>;

export function createRollbackRunner(options: RollbackOptions): RollbackRunner {
  const going = new Set<string>();
  return {
    run: async (start) => {
      const operationId = start.operationId;
      if (start.state !== "rolling_back" || operationId === null || going.has(operationId)) return;
      going.add(operationId);
      let record = start;
      const log = (level: "info" | "warn" | "error", event: string, code?: string): void => options.logger.log({ level, event, ...(code === undefined ? {} : { code }), operationId });
      const originalCode = record.error?.code ?? "ROLLBACK";
      const failed = (code: string): void => {
        const next = transition(record, "recovery_failed", { error: { code } }, options.nowIso());
        if (next.ok) options.journal.write(next.record);
        log("error", "updater.recovery_failed", code);
      };
      try {
        if (record.backupId === null) return failed("NO_SNAPSHOT");
        // 1. The apps of the project: the old one by the journal (or the only one there is), the new one when the swap made it.
        const replacement = record.replacement ?? null;
        let app: { id: string; name: string };
        try {
          app = replacement === null ? await options.scope.findApp() : { id: replacement.previousId, name: replacement.name };
          // A new container that the swap made but never wrote to the journal is found by what it is, not by its id, and is removed first: it holds the name
          // the old app is given back (a swap cut short leaves it created and under that name, and the rename would be refused while it is there).
          await options.scope.retireOthers(app.id);
          if (replacement !== null) await options.scope.retireReplacement({ previousId: replacement.previousId, previousName: replacement.previousName, nextId: replacement.nextId ?? "", name: replacement.name });
          if (await options.scope.isRunning(app.id)) await options.scope.stopApp(app);
        } catch (error) {
          return failed(error instanceof ScopeError ? error.code : "RETIRE_FAILED");
        }
        // 2. The database from the copy, and the operation of the gate ended by the same command.
        let helper: Awaited<ReturnType<typeof options.scope.runRecovery>>;
        try {
          const image = await options.scope.imageOfApp(app.id);
          helper = await options.scope.runRecovery(app, image, record.backupId, operationId);
        } catch (error) {
          return failed(error instanceof ScopeError ? error.code : "RESTORE_FAILED");
        }
        if (helper.exitCode !== 0) return failed("RESTORE_FAILED");
        // 3. The choice of the release as it was.
        const filed = restoreReleaseFile(options.controlDir, record.previousReleaseFile ?? null);
        if (!filed.ok) return failed("RELEASE_FILE_RESTORE_FAILED");
        // 4. The old app, started and healthy; only then is the way back written as made, and the operation ends.
        try {
          await options.scope.startApp(app);
          await options.scope.waitHealthy(app.id, options.healthTimeoutMs ?? ROLLBACK_HEALTH_TIMEOUT_MS);
        } catch (error) {
          return failed(error instanceof ScopeError ? error.code : "A_UNHEALTHY");
        }
        const back = transition(record, "rolled_back", {}, options.nowIso());
        if (!back.ok) return failed("TRANSITION_REFUSED");
        options.journal.write(back.record);
        record = back.record;
        const idle = transition(record, "idle", { error: { code: originalCode } }, options.nowIso());
        if (idle.ok) options.journal.write(idle.record);
        log("info", "updater.rolled_back", originalCode);
      } catch {
        failed("ROLLBACK_FAILED");
      } finally {
        going.delete(operationId);
      }
    },
  };
}
