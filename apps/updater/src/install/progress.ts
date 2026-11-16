// What the app tells the updater between the pull and the switch (Architektura §11.2.2 steps 2 and 3; D54.2): that it is
// quiet (`quiesced`), that the `pre_update` copy is taken (`backed_up`), that it gives the operation up (`abort`), and, as
// the new app, that it is ready (`ready`, D55.3: the proof that ends in the commit point). Each
// command names the operation and the fence it holds: another operation, an older fence and a state that cannot take the
// command are refused, and the same command asked again is answered as it was, so a lost answer costs nothing. A copy that
// is not there, a release the catalog no longer lists or no way back close the operation as `idle` with a code, through
// `rolling_back` and `rolled_back`, and the app may open its writes again: A was never touched. The record is on the journal
// before the answer, and the commands are taken one at a time, so two of them never read the same record.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import type { UpdateRecord } from "@openlife/contracts/updates/state";
import type { Journal } from "../journal/journal.js";
import { checkBackup } from "../release/backup-check.js";
import { findRelease, readCatalog } from "../release/catalog.js";
import type { PreviousSelection } from "../release/previous-selection.js";
import { RELEASE_FILE_NAME, readReleaseFile, writeReleaseFile, type ReleaseSelection } from "../release/release-file.js";
import { confirmCommit, initialRecord, transition } from "../state-machine/transitions.js";

export type ProgressRefusal = "OPERATION_MISMATCH" | "STALE_FENCE" | "FENCE_MISMATCH" | "WRONG_STATE" | "TRANSITION_REFUSED" | "BACKUP_MISSING" | "BACKUP_INVALID" | "PREVIOUS_UNKNOWN" | "RELEASE_UNKNOWN" | "CATALOG_MISSING" | "CATALOG_TOO_LARGE" | "CATALOG_INVALID" | "VERSION_MISMATCH" | "SCHEMA_MISMATCH" | "RELEASE_FILE_FAILED";
export type ProgressResult = Readonly<{ ok: true; record: UpdateRecord }> | Readonly<{ ok: false; code: ProgressRefusal; record: UpdateRecord }>;

export type ProgressOptions = Readonly<{
  journal: Journal;
  catalogDir: string;
  backupDir: string;
  previousSelection: () => Promise<PreviousSelection | null>;
  /** Removes the app that was replaced, once the choice of the release is committed (D55.3); a failure is the caller's to log, never a reason to undo the commit. */
  discardPrevious: (replacement: NonNullable<UpdateRecord["replacement"]>) => Promise<void>;
  nowIso: () => string;
}>;

export type ProgressHandler = Readonly<{ handle: (envelope: UpdaterEnvelope) => Promise<ProgressResult | "JOURNAL_UNREADABLE"> }>;

export function createProgressHandler(options: ProgressOptions): ProgressHandler {
  let queue: Promise<unknown> = Promise.resolve();

  /** Closes an operation that has not switched: nothing of A was touched, so the way back is a record, not an action. */
  function closeBeforeSwitch(record: UpdateRecord, code: string): UpdateRecord {
    let current = record;
    for (const to of ["rolling_back", "rolled_back", "idle"] as const) {
      const next = transition(current, to, to === "idle" ? { error: { code } } : {}, options.nowIso());
      if (!next.ok) break;
      options.journal.write(next.record);
      current = next.record;
    }
    return current;
  }

  /**
   * The proof of the new app (D55.3; Architektura §11.2.2 step 7). The version of the application and of the schema it reports
   * are compared with the release of the catalog, not with anything the app says about itself; a proof that does not fit stops the
   * operation in `rolling_back` (the way back is D56). A proof that fits goes through `committing`: the choice of the release is
   * written to the file, read back and compared, and only then is the commit point written to the journal (the one from which
   * no way back to the snapshot is taken, because it would lose what is written after it); the operation is `completed` and
   * the replaced app is discarded, whose failure does not undo the commit.
   */
  async function ready(
    record: UpdateRecord,
    command: Extract<UpdaterEnvelope["command"], { type: "ready" }>,
    accept: (next: UpdateRecord) => ProgressResult,
    refuse: (code: ProgressRefusal) => ProgressResult,
  ): Promise<ProgressResult> {
    // The same proof asked again, because the answer was lost, is answered as it was.
    if (record.committed && (record.state === "committing" || record.state === "completed")) return accept(record);
    if (record.state !== "verifying") return refuse("WRONG_STATE");
    const stop = (code: ProgressRefusal): ProgressResult => {
      const next = transition(record, "rolling_back", { error: { code } }, options.nowIso());
      if (!next.ok) return refuse("TRANSITION_REFUSED");
      options.journal.write(next.record);
      return { ok: false, code, record: next.record };
    };
    if (record.targetRelease === null || command.appVersion !== record.targetRelease) return stop("VERSION_MISMATCH");
    const catalog = readCatalog(options.catalogDir);
    if (!catalog.ok) return stop(catalog.code);
    const release = findRelease(catalog.catalog, record.targetRelease);
    if (release === null) return stop("RELEASE_UNKNOWN");
    if (command.schemaVersion !== release.schemaVersion || record.schemaVersionTo !== release.schemaVersion) return stop("SCHEMA_MISMATCH");
    const committing = transition(record, "committing", {}, options.nowIso());
    if (!committing.ok) return refuse("TRANSITION_REFUSED");
    options.journal.write(committing.record);
    const selection = selectionFor(options.catalogDir, release.app);
    const written = writeReleaseFile(options.catalogDir, selection);
    const durable = written.ok && sameSelection(options.catalogDir, selection);
    if (!durable) {
      const back = transition(committing.record, "rolling_back", { error: { code: "RELEASE_FILE_FAILED" } }, options.nowIso());
      if (back.ok) options.journal.write(back.record);
      return { ok: false, code: "RELEASE_FILE_FAILED", record: back.ok ? back.record : committing.record };
    }
    const committed = confirmCommit(committing.record, options.nowIso());
    if (!committed.ok) return refuse("TRANSITION_REFUSED");
    options.journal.write(committed.record);
    const completed = transition(committed.record, "completed", {}, options.nowIso());
    if (!completed.ok) return accept(committed.record);
    options.journal.write(completed.record);
    if (record.replacement !== null && record.replacement !== undefined) await options.discardPrevious(record.replacement).catch(() => undefined);
    return accept(completed.record);
  }

  async function run(envelope: UpdaterEnvelope): Promise<ProgressResult | "JOURNAL_UNREADABLE"> {
    const read = options.journal.read();
    if (!read.ok) return "JOURNAL_UNREADABLE";
    const record = read.record ?? initialRecord(options.nowIso());
    const command = envelope.command;
    if (command.type !== "quiesced" && command.type !== "backed_up" && command.type !== "abort" && command.type !== "ready") return { ok: false, code: "TRANSITION_REFUSED", record };
    const refuse = (code: ProgressRefusal): ProgressResult => ({ ok: false, code, record });
    if (record.operationId !== envelope.operationId) return refuse("OPERATION_MISMATCH");
    if (command.fence < record.fence) return refuse("STALE_FENCE");
    if (command.fence > record.fence) return refuse("FENCE_MISMATCH");
    const accept = (next: UpdateRecord): ProgressResult => ({ ok: true, record: next });

    if (command.type === "quiesced") {
      if (record.state === "backing_up" || record.state === "switching") return accept(record);
      if (record.state !== "quiescing") return refuse("WRONG_STATE");
      const next = transition(record, "backing_up", {}, options.nowIso());
      if (!next.ok) return refuse("TRANSITION_REFUSED");
      options.journal.write(next.record);
      return accept(next.record);
    }

    if (command.type === "abort") {
      // An operation that was closed by an abort or by a refusal is closed: asking again says so.
      if (record.state === "idle" && record.error !== null) return accept(record);
      if (record.state !== "quiescing" && record.state !== "backing_up") return refuse("WRONG_STATE");
      return accept(closeBeforeSwitch(record, "ABORTED"));
    }

    if (command.type === "ready") return ready(record, command, accept, refuse);

    // backed_up
    if (record.state === "switching") return record.backupId === command.backupId ? accept(record) : refuse("WRONG_STATE");
    if (record.state !== "backing_up") return refuse("WRONG_STATE");
    const fail = (code: ProgressRefusal): ProgressResult => ({ ok: false, code, record: closeBeforeSwitch(record, code) });
    const backup = checkBackup(options.backupDir, command.backupId);
    if (!backup.ok) return fail(backup.code);
    const catalog = readCatalog(options.catalogDir);
    if (!catalog.ok) return fail(catalog.code);
    const release = record.targetRelease === null ? null : findRelease(catalog.catalog, record.targetRelease);
    if (release === null) return fail("RELEASE_UNKNOWN");
    const previous = await options.previousSelection();
    if (previous === null || previous.app === null) return fail("PREVIOUS_UNKNOWN");
    const next = transition(record, "switching", { backupId: command.backupId, previousSelection: previous, previousDigest: previous.app, schemaVersionFrom: backup.schemaVersion, schemaVersionTo: release.schemaVersion }, options.nowIso());
    if (!next.ok) return refuse("TRANSITION_REFUSED");
    options.journal.write(next.record);
    return accept(next.record);
  }

  return {
    handle: (envelope) => {
      const result = queue.then(() => run(envelope));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

/** The pins the release file holds after the commit: the app of the release and the updater the installation has (none when it has no file). */
function selectionFor(controlDir: string, app: ReleaseSelection["app"]): ReleaseSelection {
  let updater: ReleaseSelection["updater"] = null;
  try {
    const current = readReleaseFile(readFileSync(path.join(controlDir, RELEASE_FILE_NAME), "utf8"));
    if (current.ok) updater = current.selection.updater;
  } catch {
    // No file yet: the installation runs the images of its compose file and keeps its updater.
  }
  return { app, updater };
}

/** The file on disk, read again, holds exactly the selection that was meant. */
function sameSelection(controlDir: string, selection: ReleaseSelection): boolean {
  try {
    const back = readReleaseFile(readFileSync(path.join(controlDir, RELEASE_FILE_NAME), "utf8"));
    return back.ok && JSON.stringify(back.selection) === JSON.stringify(selection);
  } catch {
    return false;
  }
}
