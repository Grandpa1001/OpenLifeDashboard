// What the app tells the updater between the pull and the switch (Architektura §11.2.2 steps 2 and 3; D54.2): that it is
// quiet (`quiesced`), that the `pre_update` copy is taken (`backed_up`), or that it gives the operation up (`abort`). Each
// command names the operation and the fence it holds: another operation, an older fence and a state that cannot take the
// command are refused, and the same command asked again is answered as it was, so a lost answer costs nothing. A copy that
// is not there, a release the catalog no longer lists or no way back close the operation as `idle` with a code, through
// `rolling_back` and `rolled_back`, and the app may open its writes again: A was never touched. The record is on the journal
// before the answer, and the commands are taken one at a time, so two of them never read the same record.
import type { UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import type { UpdateRecord } from "@openlife/contracts/updates/state";
import type { Journal } from "../journal/journal.js";
import { checkBackup } from "../release/backup-check.js";
import { findRelease, readCatalog } from "../release/catalog.js";
import type { PreviousSelection } from "../release/previous-selection.js";
import { initialRecord, transition } from "../state-machine/transitions.js";

export type ProgressRefusal = "OPERATION_MISMATCH" | "STALE_FENCE" | "FENCE_MISMATCH" | "WRONG_STATE" | "TRANSITION_REFUSED" | "BACKUP_MISSING" | "BACKUP_INVALID" | "PREVIOUS_UNKNOWN" | "RELEASE_UNKNOWN" | "CATALOG_MISSING" | "CATALOG_TOO_LARGE" | "CATALOG_INVALID";
export type ProgressResult = Readonly<{ ok: true; record: UpdateRecord }> | Readonly<{ ok: false; code: ProgressRefusal; record: UpdateRecord }>;

export type ProgressOptions = Readonly<{
  journal: Journal;
  catalogDir: string;
  backupDir: string;
  previousSelection: () => Promise<PreviousSelection | null>;
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

  async function run(envelope: UpdaterEnvelope): Promise<ProgressResult | "JOURNAL_UNREADABLE"> {
    const read = options.journal.read();
    if (!read.ok) return "JOURNAL_UNREADABLE";
    const record = read.record ?? initialRecord(options.nowIso());
    const command = envelope.command;
    if (command.type !== "quiesced" && command.type !== "backed_up" && command.type !== "abort") return { ok: false, code: "TRANSITION_REFUSED", record };
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
