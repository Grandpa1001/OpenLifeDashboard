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
import type { UpdateRecord } from "@openlife/contracts/updates/state";

export type SwitchOptions = Readonly<{
  journal: Journal;
  catalogDir: string;
  scope: Pick<ProjectScope, "findApp" | "replaceApp">;
  nowIso: () => string;
  logger: UpdaterLogger;
}>;

export type ReleaseSwitcher = Readonly<{ run: (record: UpdateRecord) => Promise<void> }>;

export function createReleaseSwitcher(options: SwitchOptions): ReleaseSwitcher {
  return {
    run: async (start) => {
      let record = start;
      const operationId = record.operationId ?? undefined;
      const log = (level: "info" | "warn", event: string, code?: string): void => options.logger.log({ level, event, ...(code === undefined ? {} : { code }), ...(operationId === undefined ? {} : { operationId }) });
      const stop = (code: string): void => {
        const next = transition(record, "rolling_back", { error: { code } }, options.nowIso());
        if (next.ok) options.journal.write(next.record);
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
        // What is about to be replaced is on the journal before anything is done to it.
        record = amendRecord(record, { replacement: { previousId: app.id, previousName: app.name, nextId: null, name: app.name } }, options.nowIso());
        options.journal.write(record);
        let replaced: Awaited<ReturnType<typeof options.scope.replaceApp>>;
        try {
          replaced = await options.scope.replaceApp(app, imageOf(release.app));
        } catch (error) {
          return stop(error instanceof ScopeError ? error.code : "SWITCH_FAILED");
        }
        record = amendRecord(record, { replacement: { previousId: replaced.previousId, previousName: replaced.previousName, nextId: replaced.nextId, name: replaced.name } }, options.nowIso());
        options.journal.write(record);
        const verifying = transition(record, "verifying", {}, options.nowIso());
        if (!verifying.ok) return stop("TRANSITION_REFUSED");
        options.journal.write(verifying.record);
        log("info", "updater.switched");
      } catch {
        log("warn", "updater.switch_failed", "SWITCH_FAILED");
      }
    },
  };
}
