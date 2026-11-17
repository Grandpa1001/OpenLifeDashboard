// What the updater does with an operation it finds on its journal when it starts (Architektura §11.2.2 "Po restarcie updatera każdy stan ma regułę
// rekonsyliacji"; D56.2). The record is the truth about what was decided; the containers and the files are looked at by the steps it begins, which
// look first. No state ends with the writes opened by default: whatever the journal and the containers do not settle ends in `recovery_failed`
// (the steps of the way back say so) and the gate stays closed.
//   idle, completed, recovery_failed   nothing: nothing is held, or only the operator closes it
//   rolled_back                        the operation ends `idle` with the code it was stopped with
//   checking, pulling                  `idle` with UPDATER_RESTARTED: nothing of the app was touched
//   quiescing, backing_up              the app still holds its own operation; the operation ends as an abort does, and the app sees the refusal
//   switching                          the way back (the swap is not made again by asking, and may be half done)
//   verifying                          the new app is watched again from the full time; a swap that is not on the journal as made goes back
//   committing                         the commit point is on the journal: the operation is completed; it is not: the way back puts the file back
//   rolling_back                       the way back goes on, from the beginning (every step looks first)
import type { UpdateRecord } from "@openlife/contracts/updates/state";
import type { Journal } from "../journal/journal.js";
import type { UpdaterLogger } from "../logging.js";
import { transition } from "../state-machine/transitions.js";
import type { RollbackRunner } from "./roll-back.js";
import type { ReleaseSwitcher } from "./switch-release.js";

export type RecoveryOptions = Readonly<{
  journal: Journal;
  rollback: RollbackRunner;
  switcher: Pick<ReleaseSwitcher, "watch">;
  /** Removes the replaced app once the choice is committed; a failure is logged and never undoes the commit. */
  discardPrevious: (replacement: NonNullable<UpdateRecord["replacement"]>) => Promise<void>;
  nowIso: () => string;
  logger: UpdaterLogger;
}>;

/** What was done, for the log and the tests. */
export type RecoveryAction = "none" | "closed" | "ended" | "rolling_back" | "watching" | "completed" | "unreadable";

export async function recoverOnStart(options: RecoveryOptions): Promise<RecoveryAction> {
  const read = options.journal.read();
  if (!read.ok) return "unreadable";
  const record = read.record;
  if (record === null) return "none";
  const operationId = record.operationId ?? undefined;
  const log = (action: RecoveryAction): RecoveryAction => {
    options.logger.log({ level: action === "none" ? "info" : "warn", event: "updater.recovered", code: `${record.state}:${action}`, ...(operationId === undefined ? {} : { operationId }) });
    return action;
  };
  const write = (to: Parameters<typeof transition>[1], patch: Parameters<typeof transition>[2]): UpdateRecord | null => {
    const next = transition(record, to, patch, options.nowIso());
    if (!next.ok) return null;
    options.journal.write(next.record);
    return next.record;
  };
  const stop = (code: string): RecoveryAction => {
    const next = write("rolling_back", { error: { code } });
    if (next === null) return log("none");
    void options.rollback.run(next);
    return log("rolling_back");
  };
  switch (record.state) {
    case "idle":
    case "completed":
    case "recovery_failed":
      return log("none");
    case "rolled_back":
      write("idle", {});
      return log("closed");
    case "checking":
    case "pulling":
      write("idle", { error: { code: "UPDATER_RESTARTED" } });
      return log("closed");
    case "quiescing":
    case "backing_up": {
      // The app has not been touched and holds its own operation; ending it here is what `abort` does, and the app finds out at its next command.
      const back = transition(record, "rolling_back", { error: { code: "UPDATER_RESTARTED" } }, options.nowIso());
      if (!back.ok) return log("none");
      options.journal.write(back.record);
      const rolled = transition(back.record, "rolled_back", {}, options.nowIso());
      if (rolled.ok) options.journal.write(rolled.record);
      const idle = rolled.ok ? transition(rolled.record, "idle", {}, options.nowIso()) : null;
      if (idle?.ok) options.journal.write(idle.record);
      return log("closed");
    }
    case "switching":
      return stop("UPDATER_RESTARTED");
    case "verifying":
      // A swap whose new container is not on the journal was cut short, and what it left (a container that was created and never started, the old app
      // stopped or renamed aside) is not something to wait for: the way back looks at the containers and puts the old app back.
      if ((record.replacement ?? null) === null || record.replacement?.nextId === null) return stop("UPDATER_RESTARTED");
      options.switcher.watch(record);
      return log("watching");
    case "committing": {
      if (!record.committed) return stop("UPDATER_RESTARTED");
      const done = write("completed", {});
      if (done !== null && record.replacement !== null && record.replacement !== undefined) await options.discardPrevious(record.replacement).catch(() => undefined);
      return log("completed");
    }
    case "rolling_back":
      void options.rollback.run(record);
      return log("rolling_back");
  }
}
