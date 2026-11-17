// The switch of the app, driven by the updater alone (Architektura §11.2.2 step 5; D55.1): in `switching` the image of the
// release comes from the trusted catalog (never from a command), the containers of the switch are written to the journal
// before the app is replaced and again after it, and the app A is replaced by B (`replaceApp`: B is made under the name of A,
// A is renamed aside and stopped, B starts; A is kept stopped until the commit point). The operation then waits in
// `verifying` for B to prove itself (D55.3). A failure stops the operation in `rolling_back` with a code and nothing else:
// the way back, and what A looks like after a failed swap, is D56. A release that replaces the updater is not made from
// the UI (it is refused when the operation begins, and again here).
import { ScopeError, type ProjectScope } from "../docker/project-scope.js";
import type { Journal } from "../journal/journal.js";
import type { UpdaterLogger } from "../logging.js";
import { findRelease, readCatalog } from "../release/catalog.js";
import { imageOf } from "../release/release-file.js";
import { amendRecord, transition } from "../state-machine/transitions.js";
import { START_TIMEOUT_MS, WATCH_INTERVAL_MS } from "./update-limits.js";
import type { UpdateRecord } from "@openlife/contracts/updates/state";

export type SwitchOptions = Readonly<{
  journal: Journal;
  catalogDir: string;
  scope: Pick<ProjectScope, "findApp" | "replaceApp">;
  /** What lets the updater look at the new app while it waits for its proof (D56.2); without it only the time is watched. */
  watchScope?: Pick<ProjectScope, "describeContainer" | "logEvents">;
  /** How often the new app is looked at; the constant of the protocol unless a test narrows it. */
  watchIntervalMs?: number;
  nowIso: () => string;
  logger: UpdaterLogger;
  /** How long the new app has to say it is ready; the constant of the protocol unless a test narrows it. */
  startTimeoutMs?: number;
  /** Called with the record when the operation is stopped in `rolling_back`, so the way back can be driven (D56.1). */
  onStopped?: (record: UpdateRecord) => void;
}>;

export type ReleaseSwitcher = Readonly<{
  run: (record: UpdateRecord) => Promise<void>;
  /** Watches the new app of an operation in `verifying` until it has proved itself or the operation ends otherwise; also what the recovery after a restart of the updater begins again (D56.2). */
  watch: (record: UpdateRecord) => void;
}>;

export function createReleaseSwitcher(options: SwitchOptions): ReleaseSwitcher {
  const watching = new Set<string>();

  /** Why the new app is no longer what the updater waits for, as a code: it was killed for memory, its start was refused by a failed migration, or it ended or is started again and again. */
  async function failureOfNewApp(nextId: string): Promise<string | null> {
    const watchScope = options.watchScope;
    if (watchScope === undefined) return null;
    let state: Awaited<ReturnType<typeof watchScope.describeContainer>>;
    try {
      state = await watchScope.describeContainer(nextId);
    } catch {
      return "B_MISSING";
    }
    if (state.oomKilled) return "B_OOM_KILLED";
    const ended = !state.running && (state.status === "exited" || state.status === "dead");
    if (!ended && state.restartCount === 0) return null;
    // Docker may have started the app again after its first failure, whose reason is what matters, so every event of the log is read, not the last.
    const events = await watchScope.logEvents(nextId).catch(() => []);
    return events.some((event) => event.event === "bootstrap.failed" && event.code === "MIGRATION_FAILED") ? "B_MIGRATION_FAILED" : "B_EXITED";
  }

  function watch(record: UpdateRecord): void {
    const id = record.operationId;
    if (record.state !== "verifying" || id === null || watching.has(id)) return;
    watching.add(id);
    const started = Date.now();
    const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    const intervalMs = options.watchIntervalMs ?? WATCH_INTERVAL_MS;
    const tick = async (): Promise<void> => {
      let again = true;
      try {
        const read = options.journal.read();
        const current = read.ok ? read.record : null;
        if (current === null || current.state !== "verifying" || current.operationId !== id) {
          again = false;
          return;
        }
        const nextId = current.replacement?.nextId ?? null;
        const code = (nextId === null ? null : await failureOfNewApp(nextId)) ?? (Date.now() - started >= timeoutMs ? "START_TIMEOUT" : null);
        if (code !== null) {
          again = false;
          const stopped = transition(current, "rolling_back", { error: { code } }, options.nowIso());
          if (stopped.ok) {
            options.journal.write(stopped.record);
            options.onStopped?.(stopped.record);
          }
          options.logger.log({ level: "warn", event: "updater.switch_failed", code, operationId: id });
        }
      } catch {
        // A look that fails is made again at the next tick; the time still runs out.
      } finally {
        if (again) schedule();
        else watching.delete(id);
      }
    };
    const schedule = (): void => {
      const remaining = Math.max(1, timeoutMs - (Date.now() - started));
      setTimeout(() => void tick(), Math.min(intervalMs, remaining)).unref();
    };
    schedule();
  }

  return {
    watch,
    run: async (start) => {
      let record = start;
      const operationId = record.operationId ?? undefined;
      const log = (level: "info" | "warn", event: string, code?: string): void => options.logger.log({ level, event, ...(code === undefined ? {} : { code }), ...(operationId === undefined ? {} : { operationId }) });
      const stop = (code: string): void => {
        const next = transition(record, "rolling_back", { error: { code } }, options.nowIso());
        if (next.ok) {
          options.journal.write(next.record);
          options.onStopped?.(next.record);
        }
        log("warn", "updater.switch_failed", code);
      };
      try {
        if (record.state !== "switching") return;
        const read = readCatalog(options.catalogDir);
        if (!read.ok) return stop(read.code);
        const release = record.targetRelease === null ? null : findRelease(read.catalog, record.targetRelease);
        if (release === null) return stop("RELEASE_UNKNOWN");
        if (release.updater !== null) return stop("RELEASE_REQUIRES_ADMIN");
        let app: Awaited<ReturnType<typeof options.scope.findApp>>;
        try {
          app = await options.scope.findApp();
        } catch (error) {
          return stop(error instanceof ScopeError ? error.code : "APP_NOT_FOUND");
        }
        // The operation is `verifying` and what is about to be replaced is on the journal before anything is done to it: the new app asks the updater
        // about the operation the moment it starts, and an updater that still said `switching` would make it refuse to start.
        const verifying = transition(record, "verifying", { replacement: { previousId: app.id, previousName: app.name, nextId: null, name: app.name } }, options.nowIso());
        if (!verifying.ok) return stop("TRANSITION_REFUSED");
        options.journal.write(verifying.record);
        record = verifying.record;
        let replaced: Awaited<ReturnType<typeof options.scope.replaceApp>>;
        try {
          replaced = await options.scope.replaceApp(app, imageOf(release.app));
        } catch (error) {
          return stop(error instanceof ScopeError ? error.code : "SWITCH_FAILED");
        }
        record = amendRecord(record, { replacement: { previousId: replaced.previousId, previousName: replaced.previousName, nextId: replaced.nextId, name: replaced.name } }, options.nowIso());
        options.journal.write(record);
        log("info", "updater.switched");
        // The new app is watched while it has the time to prove itself: when it ends, is killed or is started again, or the time passes, the
        // operation stops in `rolling_back` (the way back is D56.1) and a proof that comes after that is refused.
        watch(record);
      } catch {
        log("warn", "updater.switch_failed", "SWITCH_FAILED");
      }
    },
  };
}
