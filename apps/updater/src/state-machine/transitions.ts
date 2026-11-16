// The state machine of an update as a table (Architektura §11.2.2; D52.2). Pure: it is given the record and the
// state to go to and says whether that is allowed and what the next record is; the writing of it and everything
// the state means (containers, files) is for the other parts of the updater. Every state of the architecture has
// its way out, an error before the commit point leads back through `rolling_back`, a failure of the way back to
// `recovery_failed`, and from the commit point on no rollback to the snapshot is possible.
import { ACTIVE_UPDATE_STATES, type UpdateRecord, type UpdateState } from "@openlife/contracts/updates/state";

/** The ways between the states, without the rule of the commit point (that one needs the record). */
export const TRANSITIONS: Readonly<Record<UpdateState, readonly UpdateState[]>> = {
  idle: ["checking"],
  // A check or a pull that fails leaves the app A running as it was: back to idle with the error written.
  checking: ["pulling", "idle"],
  pulling: ["quiescing", "idle"],
  quiescing: ["backing_up", "rolling_back"],
  backing_up: ["switching", "rolling_back"],
  switching: ["verifying", "rolling_back"],
  verifying: ["committing", "rolling_back"],
  committing: ["completed", "rolling_back", "recovery_failed"],
  completed: ["idle", "checking"],
  rolling_back: ["rolled_back", "recovery_failed"],
  rolled_back: ["idle", "checking"],
  // Only an operator closes it (the tool of the operator writes `idle` with the id of the operation it resolved).
  recovery_failed: ["idle"],
};

export type TransitionRefusal = "TRANSITION_REFUSED" | "AFTER_COMMIT_POINT";

export type TransitionPatch = Partial<Pick<UpdateRecord, "operationId" | "fence" | "targetRelease" | "targetDigest" | "previousDigest" | "schemaVersionFrom" | "schemaVersionTo" | "backupId" | "previousSelection" | "replacement" | "previousReleaseFile" | "committed" | "error">>;

/** True while an operation holds the instance: a new one is not taken, and the app is not given back its writes unasked. */
export const isActive = (state: UpdateState): boolean => ACTIVE_UPDATE_STATES.includes(state);

export function canTransition(record: UpdateRecord, to: UpdateState): boolean {
  if (!TRANSITIONS[record.state].includes(to)) return false;
  // From the commit point on, a failure never goes back to the snapshot: the data written since would be lost.
  if (record.committed && to === "rolling_back") return false;
  // The commit point is reached inside `committing`, so `completed` is only after it.
  if (to === "completed" && !record.committed) return false;
  return true;
}

export function transition(record: UpdateRecord, to: UpdateState, patch: TransitionPatch, nowIso: string): Readonly<{ ok: true; record: UpdateRecord }> | Readonly<{ ok: false; code: TransitionRefusal }> {
  if (!canTransition(record, to)) return { ok: false, code: record.committed && to === "rolling_back" ? "AFTER_COMMIT_POINT" : "TRANSITION_REFUSED" };
  const closing = to === "idle";
  const next: UpdateRecord = {
    ...record,
    ...patch,
    state: to,
    seq: record.seq + 1,
    updatedAt: nowIso,
    // An error is kept while the state says what happened and is cleared when a new operation starts.
    error: patch.error === undefined ? (to === "checking" ? null : record.error) : patch.error,
  };
  // A new operation starts from a clean record: nothing of the one before is carried into it, except the fence (it only grows).
  if (to === "checking") {
    return { ok: true, record: { ...next, targetDigest: patch.targetDigest ?? null, previousDigest: null, schemaVersionFrom: null, schemaVersionTo: null, backupId: null, previousSelection: null, replacement: null, previousReleaseFile: null, committed: false, error: null } };
  }
  return { ok: true, record: closing ? { ...next, committed: false } : next };
}

/** The record of an installation that never updated. */
export function initialRecord(nowIso: string): UpdateRecord {
  return { v: 1, seq: 0, operationId: null, state: "idle", fence: 0, targetRelease: null, targetDigest: null, previousDigest: null, schemaVersionFrom: null, schemaVersionTo: null, backupId: null, previousSelection: null, replacement: null, previousReleaseFile: null, committed: false, error: null, updatedAt: nowIso };
}

/** The commit point: inside `committing`, once the choice of the image is durable. From the next record on, no rollback to the snapshot. */
export function confirmCommit(record: UpdateRecord, nowIso: string): Readonly<{ ok: true; record: UpdateRecord }> | Readonly<{ ok: false; code: TransitionRefusal }> {
  if (record.state !== "committing" || record.committed) return { ok: false, code: "TRANSITION_REFUSED" };
  return { ok: true, record: { ...record, committed: true, seq: record.seq + 1, updatedAt: nowIso } };
}

/** A change to the record that is no change of state (what a step has learned while it works): the same state, the next number. */
export function amendRecord(record: UpdateRecord, patch: Pick<TransitionPatch, "replacement">, nowIso: string): UpdateRecord {
  return { ...record, ...patch, seq: record.seq + 1, updatedAt: nowIso };
}
