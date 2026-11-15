// D52.2 — the state machine of an update and the start of an operation (Architektura §11.2.2).
// AC1: the table allows exactly the ways between the states that the architecture names, and every other pair
//      is refused; an error before the commit point goes back through rolling_back, a failed way back to
//      recovery_failed, and recovery_failed leaves only to idle.
// AC2: from the commit point on no rollback is made (the data written since would be lost) and completed is
//      reached only after it; a command with a smaller fence than the one accepted is refused as a crashed writer,
//      a second operation is refused while one runs, and the same operation asked again is the one that runs.
import { randomUUID } from "node:crypto";
import { UPDATE_STATES, type UpdateRecord, type UpdateState } from "@openlife/contracts/updates/state";
import type { UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { describe, expect, it } from "vitest";
import { beginInstall } from "../../../apps/updater/src/state-machine/begin.js";
import { canTransition, confirmCommit, initialRecord, isActive, transition, TRANSITIONS } from "../../../apps/updater/src/state-machine/transitions.js";

const NOW = "2026-11-15T12:00:00.000Z";
const recordIn = (state: UpdateState, over: Partial<UpdateRecord> = {}): UpdateRecord => ({ ...initialRecord(NOW), state, operationId: randomUUID(), targetRelease: "1.2.3", ...over });
const install = (fence: number, over: Partial<UpdaterEnvelope> = {}): UpdaterEnvelope => ({ v: 1, operationId: randomUUID(), issuedAt: Date.parse(NOW), nonce: "n".repeat(24), command: { type: "install", release: "1.2.3", fence }, ...over }) as UpdaterEnvelope;

describe("D52.2-AC1 the table of the ways between the states", () => {
  it("allows exactly the ways the architecture names", () => {
    const expected: ReadonlyArray<readonly [UpdateState, UpdateState]> = [
      ["idle", "checking"], ["checking", "pulling"], ["checking", "idle"], ["pulling", "quiescing"], ["pulling", "idle"],
      ["quiescing", "backing_up"], ["quiescing", "rolling_back"], ["backing_up", "switching"], ["backing_up", "rolling_back"],
      ["switching", "verifying"], ["switching", "rolling_back"], ["verifying", "committing"], ["verifying", "rolling_back"],
      ["committing", "completed"], ["committing", "rolling_back"], ["committing", "recovery_failed"],
      ["completed", "idle"], ["completed", "checking"], ["rolling_back", "rolled_back"], ["rolling_back", "recovery_failed"],
      ["rolled_back", "idle"], ["rolled_back", "checking"], ["recovery_failed", "idle"],
    ];
    const actual = UPDATE_STATES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));
    expect(actual.map((pair) => pair.join(">")).sort()).toEqual(expected.map((pair) => pair.join(">")).sort());
  });

  it("refuses every pair the table does not hold, whatever the record", () => {
    for (const from of UPDATE_STATES) for (const to of UPDATE_STATES) {
      const allowed = TRANSITIONS[from].includes(to);
      const record = recordIn(from, { committed: from === "committing" && to === "completed" });
      expect(canTransition(record, to), `${from} > ${to}`).toBe(allowed);
    }
  });

  it("has a way out of every state and a way back from every state before the switch that holds the instance", () => {
    for (const state of UPDATE_STATES) expect(TRANSITIONS[state].length, state).toBeGreaterThan(0);
    for (const state of ["quiescing", "backing_up", "switching", "verifying"] as const) expect(TRANSITIONS[state], state).toContain("rolling_back");
    expect(TRANSITIONS["recovery_failed"]).toEqual(["idle"]);
    expect(UPDATE_STATES.filter(isActive).sort()).toEqual(["backing_up", "checking", "committing", "pulling", "quiescing", "recovery_failed", "rolling_back", "switching", "verifying"].sort());
  });

  it("goes from a start to a complete update and back from a failed one through rolling_back, a new record each time", () => {
    let record = initialRecord(NOW);
    for (const state of ["checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing"] as const) {
      const next = transition(record, state, state === "checking" ? { operationId: randomUUID(), targetRelease: "1.2.3", fence: 3 } : {}, NOW);
      expect(next.ok, state).toBe(true);
      if (next.ok) record = next.record;
    }
    expect(record.seq).toBe(7);
    const committed = confirmCommit(record, NOW);
    expect(committed.ok && committed.record.committed).toBe(true);
    if (!committed.ok) return;
    const done = transition(committed.record, "completed", {}, NOW);
    expect(done.ok && done.record.state).toBe("completed");

    const failing = transition(recordIn("switching"), "rolling_back", { error: { code: "SWITCH_FAILED" } }, NOW);
    expect(failing.ok && failing.record).toMatchObject({ state: "rolling_back", error: { code: "SWITCH_FAILED" } });
  });
});

describe("D52.2-AC2 the commit point, the fence and the single operation", () => {
  it("does not roll back from the commit point on and reaches completed only after it", () => {
    const before = recordIn("committing");
    expect(transition(before, "completed", {}, NOW)).toEqual({ ok: false, code: "TRANSITION_REFUSED" });
    expect(transition(before, "rolling_back", {}, NOW).ok).toBe(true);
    const after = recordIn("committing", { committed: true });
    expect(transition(after, "rolling_back", {}, NOW)).toEqual({ ok: false, code: "AFTER_COMMIT_POINT" });
    expect(transition(after, "completed", {}, NOW).ok).toBe(true);
    expect(transition(after, "recovery_failed", { error: { code: "OPEN_WRITES_FAILED" } }, NOW).ok).toBe(true);
    expect(confirmCommit(recordIn("verifying"), NOW).ok).toBe(false);
    expect(confirmCommit(after, NOW).ok).toBe(false);
  });

  it("refuses a command with a smaller fence than the one accepted and takes an equal or larger one", () => {
    const record = recordIn("idle", { fence: 7 });
    expect(beginInstall(record, install(6), NOW)).toEqual({ ok: false, code: "STALE_FENCE" });
    expect(beginInstall(record, install(7), NOW)).toMatchObject({ ok: true, resumed: false });
    const higher = beginInstall(record, install(9), NOW);
    expect(higher.ok && higher.record.fence).toBe(9);
    // A running operation is not freed by a smaller fence either.
    expect(beginInstall(recordIn("pulling", { fence: 7 }), install(6), NOW)).toEqual({ ok: false, code: "STALE_FENCE" });
  });

  it("starts a clean record: nothing of the operation before is carried over, the fence only grows", () => {
    const old = recordIn("completed", { fence: 5, previousDigest: `sha256:${"a".repeat(64)}`, backupId: "20261101T000000Z-pre_update-00000000-0000-4000-8000-000000000000", committed: true, error: { code: "OLD" } });
    const started = beginInstall(old, install(5), NOW);
    expect(started.ok && started.record).toMatchObject({ state: "checking", previousDigest: null, backupId: null, committed: false, error: null, fence: 5, targetRelease: "1.2.3" });
  });

  it("refuses a second operation while one runs and while recovery has failed, and runs the same operation once", () => {
    const running = recordIn("backing_up", { fence: 2 });
    expect(beginInstall(running, install(2), NOW)).toEqual({ ok: false, code: "BUSY" });
    expect(beginInstall(recordIn("recovery_failed", { fence: 2 }), install(2), NOW)).toEqual({ ok: false, code: "BUSY" });
    const again = beginInstall(running, install(2, { operationId: running.operationId! }), NOW);
    expect(again).toMatchObject({ ok: true, resumed: true });
    expect(again.ok && again.record).toBe(running);
    // The same operation asked for another release is not the same operation.
    expect(beginInstall(running, { ...install(2, { operationId: running.operationId! }), command: { type: "install", release: "9.9.9", fence: 2 } }, NOW)).toEqual({ ok: false, code: "BUSY" });
  });

  it("refuses the start of an operation by a status command", () => {
    expect(beginInstall(recordIn("idle"), { ...install(0), command: { type: "status" } }, NOW)).toEqual({ ok: false, code: "TRANSITION_REFUSED" });
  });
});
