// The first steps of an installation, driven by the updater alone (Architektura §11.2.2 steps 1 and 2; D54.1): the
// release of the command is found in the trusted catalog (`checking`), its image is pulled by the digest of the
// catalog and proved to be that digest (`pulling`), and the operation waits for the app to be quiet (`quiescing`).
// Everything here happens while the app A still serves, so a failure closes the operation as `idle` with a code and
// touches nothing of A. The record is on the journal before each step, so a crash leaves a record that says where it
// was; the same operation asked again drives it from there (the pulls are idempotent).
import { ScopeError, type ProjectScope } from "../docker/project-scope.js";
import type { Journal } from "../journal/journal.js";
import type { UpdaterLogger } from "../logging.js";
import { readCatalog, findRelease } from "../release/catalog.js";
import { imageOf } from "../release/release-file.js";
import { transition } from "../state-machine/transitions.js";
import type { UpdateRecord } from "@openlife/contracts/updates/state";

export type PrepareOptions = Readonly<{
  journal: Journal;
  /** The control folder that holds the catalog. */
  catalogDir: string;
  scope: Pick<ProjectScope, "pullVerified">;
  nowIso: () => string;
  logger: UpdaterLogger;
}>;

export type ReleasePreparer = Readonly<{ prepare: (record: UpdateRecord) => Promise<void> }>;

export function createReleasePreparer(options: PrepareOptions): ReleasePreparer {
  return {
    prepare: async (start) => {
      let record = start;
      const operationId = record.operationId ?? undefined;
      const close = (code: string): void => {
        const closed = transition(record, "idle", { error: { code } }, options.nowIso());
        if (closed.ok) options.journal.write(closed.record);
        options.logger.log({ level: "warn", event: "updater.install_closed", code, ...(operationId === undefined ? {} : { operationId }) });
      };
      try {
        if (record.state !== "checking" && record.state !== "pulling") return;
        const read = readCatalog(options.catalogDir);
        if (!read.ok) return close(read.code);
        const release = record.targetRelease === null ? null : findRelease(read.catalog, record.targetRelease);
        if (release === null) return close("RELEASE_UNKNOWN");
        // The update from the UI replaces the app only; a release that replaces the updater is for the administrator (Architektura §11.2.1).
        if (release.updater !== null) return close("RELEASE_REQUIRES_ADMIN");
        if (record.state === "checking") {
          const pulling = transition(record, "pulling", { targetDigest: release.app.digest }, options.nowIso());
          if (!pulling.ok) return close("TRANSITION_REFUSED");
          options.journal.write(pulling.record);
          record = pulling.record;
        }
        try {
          await options.scope.pullVerified(imageOf(release.app));
        } catch (error) {
          return close(error instanceof ScopeError ? error.code : "PULL_FAILED");
        }
        const quiescing = transition(record, "quiescing", {}, options.nowIso());
        if (!quiescing.ok) return close("TRANSITION_REFUSED");
        options.journal.write(quiescing.record);
        options.logger.log({ level: "info", event: "updater.release_ready", ...(operationId === undefined ? {} : { operationId }) });
      } catch {
        // The journal could not be written or something unforeseen happened; the log says so with a code and nothing of the cause.
        options.logger.log({ level: "error", event: "updater.prepare_failed", code: "PREPARE_FAILED", ...(operationId === undefined ? {} : { operationId }) });
      }
    },
  };
}
