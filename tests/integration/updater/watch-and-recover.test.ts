// D56.2 — the watch of the new app while it proves itself, and what the updater does with an operation it finds on its journal when it starts
// (Architektura §11.2.2; DEV §9.55), through the real server of the updater on HTTP, a real journal, catalog and release file and recorded
// stand-ins for the Docker scope.
// AC1: a new app that was killed for memory, whose start was refused by a failed migration, that ended or is started again by Docker, or that is
//      gone ends the wait at once with a code of its own (B_OOM_KILLED, B_MIGRATION_FAILED, B_EXITED, B_MISSING) and the way back is made; one
//      that runs and has not said it is ready waits until the time runs out (START_TIMEOUT); one that says it is ready is no longer looked at.
// AC2: the updater that starts and finds an operation settles it by its state, in a table: nothing is held or only the operator closes it, a
//      stopped step or an operation of the app that was never switched ends, a switch or a commit that is not on the journal goes back, a
//      commit that is on the journal is completed, a new app that is waited for is watched again, a way back that was going on goes on; and
//      no state ends with anything but the old app on its copy or `recovery_failed`.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverOnStart } from "../../../apps/updater/dist/install/recover.js";
import { createRollbackRunner } from "../../../apps/updater/dist/install/roll-back.js";
import { openJournal } from "../../../apps/updater/dist/journal/journal.js";
import { initialRecord, transition } from "../../../apps/updater/dist/state-machine/transitions.js";
import { catalogFileTextOf } from "../../../apps/updater/dist/release/catalog.js";
import { catalogOf, closeServers, envelopeOf, fakeRollbackScope, fakeSwitchScope, fakeWatchScope, install, publishBackup, recordOf, release123, send, start, type Started } from "../../support/updater-harness.ts";

afterEach(closeServers);

const FENCE = 6;
const release = { ...release123, version: "1.3.0", schemaVersion: 8 };
const catalog = catalogFileTextOf(catalogOf(release123, release));
const running = { running: true, status: "running", exitCode: 0, oomKilled: false, restartCount: 0 } as const;

async function reached(server: Started, ...states: string[]): Promise<NonNullable<ReturnType<typeof recordOf>>> {
  for (let tries = 0; tries < 500; tries += 1) {
    const record = recordOf(server.dir);
    if (record !== null && states.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the operation did not reach ${states.join(" or ")}: ${JSON.stringify(recordOf(server.dir))}`);
}
async function toVerifying(server: Started): Promise<string> {
  const operationId = randomUUID();
  expect((await send(server, install("1.3.0", FENCE, operationId))).status).toBe(202);
  await reached(server, "quiescing");
  await send(server, envelopeOf({ type: "quiesced", fence: FENCE }, operationId));
  await send(server, envelopeOf({ type: "backed_up", backupId: publishBackup(server.backupDir), fence: FENCE }, operationId));
  await reached(server, "verifying");
  return operationId;
}

describe("D56.2-AC1 the new app is watched, and the way back is made at once for what the watch sees", () => {
  type State = Parameters<typeof fakeWatchScope>[0];
  const watched = async (state: State, over: { startTimeoutMs?: number } = {}) => {
    const calls: string[] = [];
    const server = await start({ catalog, switchScope: fakeSwitchScope(), rollbackScope: fakeRollbackScope(calls), watchScope: fakeWatchScope(state), watchIntervalMs: 15, startTimeoutMs: over.startTimeoutMs ?? 60_000 });
    const operationId = await toVerifying(server);
    return { server, calls, operationId };
  };

  it.each([
    ["killed for memory", "B_OOM_KILLED", { container: { ...running, running: false, status: "exited", exitCode: 137, oomKilled: true }, log: [], looks: 0 }],
    ["refused its start by a failed migration (and then by the operation it left, when Docker started it again)", "B_MIGRATION_FAILED", { container: { ...running, running: false, status: "exited", exitCode: 1 }, log: [{ event: "bootstrap.failed", code: "MIGRATION_FAILED" }, { event: "bootstrap.failed", code: "MAINTENANCE_RECOVERY_REQUIRED" }], looks: 0 }],
    ["ended for another reason", "B_EXITED", { container: { ...running, running: false, status: "exited", exitCode: 1 }, log: [{ event: "bootstrap.failed", code: "MAINTENANCE_RECOVERY_REQUIRED" }], looks: 0 }],
    ["ended with nothing in its log", "B_EXITED", { container: { ...running, running: false, status: "exited", exitCode: 0 }, log: [], looks: 0 }],
    ["started again by Docker while it runs", "B_EXITED", { container: { ...running, restartCount: 2 }, log: [], looks: 0 }],
    ["gone", "B_MISSING", { container: "missing", log: [], looks: 0 }],
  ] as const)("a new app that is %s ends the wait with %s and the way back is made", async (_name, code, state) => {
    const { server, calls, operationId } = await watched({ ...state } as unknown as State);
    const record = await reached(server, "idle");
    expect(record).toMatchObject({ error: { code }, operationId, committed: false });
    expect(calls).toContain(`runRecovery container-a ${record.backupId} ${operationId}`);
    expect(calls.at(-1)).toBe("waitHealthy container-a");
  });

  it("leaves a new app that runs alone until the time runs out, and then stops with START_TIMEOUT", async () => {
    const state: State = { container: { ...running }, log: [], looks: 0 };
    const { server } = await watched(state, { startTimeoutMs: 120 });
    expect(await reached(server, "idle")).toMatchObject({ error: { code: "START_TIMEOUT" } });
    expect(state.looks).toBeGreaterThan(1);
  });

  it("stops looking at the new app once it has proved itself", async () => {
    const state: State = { container: { ...running }, log: [], looks: 0 };
    const { server, operationId } = await watched(state);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.looks).toBeGreaterThan(0);
    expect((await send(server, envelopeOf({ type: "ready", fence: FENCE, appVersion: "1.3.0", schemaVersion: 8 }, operationId))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const looks = state.looks;
    // The container is now one that would be stopped for, but the operation is completed and nobody looks.
    state.container = "missing";
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.looks).toBe(looks);
    expect(recordOf(server.dir)).toMatchObject({ state: "completed", committed: true });
  });
});

describe("D56.2-AC2 the updater that starts settles each state of the journal", () => {
  const now = new Date().toISOString();
  /** A record of an operation in the state, made by the transitions of the machine so that it is one the updater could have written. */
  function at(state: string, over: Record<string, unknown> = {}) {
    const operationId = randomUUID();
    const path_: string[] = ["checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing"];
    let record = initialRecord(now);
    let step = transition(record, "checking", { operationId, targetRelease: "1.3.0", fence: FENCE }, now);
    if (!step.ok) throw new Error("not begun");
    record = step.record;
    for (const next of path_.slice(1)) {
      if (record.state === state) break;
      step = transition(record, next as "pulling", next === "switching" ? { backupId: "20261116T120000Z-pre_update-00000000-0000-4000-8000-000000000000" } : {}, now);
      if (!step.ok) throw new Error(`cannot go to ${next}`);
      record = step.record;
    }
    return { ...record, ...over } as typeof record;
  }
  function rig(record: ReturnType<typeof at>) {
    const dir = mkdtempSync(path.join(tmpdir(), "recover-"));
    const journal = openJournal(dir);
    journal.write(record);
    const calls: string[] = [];
    const watched: string[] = [];
    const discards: string[] = [];
    const rollback = createRollbackRunner({ journal, controlDir: dir, scope: fakeRollbackScope(calls), nowIso: () => new Date().toISOString(), logger: { log: () => undefined }, healthTimeoutMs: 50 });
    const run = () => recoverOnStart({ journal, rollback, switcher: { watch: (each) => void watched.push(each.state) }, discardPrevious: async (replacement) => void discards.push(replacement.previousId), nowIso: () => new Date().toISOString(), logger: { log: () => undefined } });
    return { dir, journal, calls, watched, discards, run, record: () => recordOf(dir) };
  }
  const swapped = { replacement: { previousId: "container-a", previousName: "openlife-app-1-previous-1234", nextId: "container-b", name: "openlife-app-1" }, previousReleaseFile: null };

  it("does nothing for an installation that never updated and for the states that hold nothing or only the operator closes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recover-"));
    expect(await recoverOnStart({ journal: openJournal(dir), rollback: createRollbackRunner({ journal: openJournal(dir), controlDir: dir, scope: fakeRollbackScope(), nowIso: () => now, logger: { log: () => undefined } }), switcher: { watch: () => undefined }, discardPrevious: async () => undefined, nowIso: () => now, logger: { log: () => undefined } })).toBe("none");
    for (const state of ["idle", "completed", "recovery_failed"] as const) {
      const base = state === "idle" ? initialRecord(now) : { ...at("verifying"), state };
      const r = rig(base as ReturnType<typeof at>);
      expect(await r.run(), state).toBe("none");
      expect(r.record(), state).toEqual(base);
      expect(r.calls, state).toEqual([]);
    }
  });

  it("ends a step that was stopped before the app was touched, with UPDATER_RESTARTED, and an operation the app never switched the same way", async () => {
    for (const state of ["checking", "pulling"] as const) {
      const r = rig(at(state));
      expect(await r.run(), state).toBe("closed");
      expect(r.record(), state).toMatchObject({ state: "idle", error: { code: "UPDATER_RESTARTED" } });
      expect(r.calls, state).toEqual([]);
    }
    for (const state of ["quiescing", "backing_up"] as const) {
      const r = rig(at(state));
      expect(await r.run(), state).toBe("closed");
      expect(r.record(), state).toMatchObject({ state: "idle", error: { code: "UPDATER_RESTARTED" }, committed: false });
      expect(r.calls, state).toEqual([]);
    }
    const rolledBack = rig({ ...at("verifying"), state: "rolled_back", error: { code: "START_TIMEOUT" } } as ReturnType<typeof at>);
    expect(await rolledBack.run()).toBe("closed");
    expect(rolledBack.record()).toMatchObject({ state: "idle", error: { code: "START_TIMEOUT" } });
  });

  it("goes back from a switch that is not known to have ended, whether or not the containers are on the journal", async () => {
    for (const over of [{}, swapped, { replacement: { ...swapped.replacement, nextId: null } }]) {
      const r = rig(at("switching", over));
      expect(await r.run()).toBe("rolling_back");
      const record = (await (async () => { for (let i = 0; i < 300; i += 1) { const each = r.record(); if (each?.state === "idle") return each; await new Promise((resolve) => setTimeout(resolve, 10)); } return r.record(); })())!;
      expect(record).toMatchObject({ state: "idle", error: { code: "UPDATER_RESTARTED" } });
      expect(r.calls.some((call) => call.startsWith("runRecovery"))).toBe(true);
      expect(r.calls.at(-1)).toBe("waitHealthy container-a");
    }
  });

  it("watches the new app again from the full time when the operation is in verifying", async () => {
    const r = rig(at("verifying", swapped));
    expect(await r.run()).toBe("watching");
    expect(r.watched).toEqual(["verifying"]);
    expect(r.record()).toMatchObject({ state: "verifying" });
    expect(r.calls).toEqual([]);
  });

  it("completes a commit that is on the journal and goes back from one that is not", async () => {
    const committed = rig(at("committing", { ...swapped, committed: true }));
    expect(await committed.run()).toBe("completed");
    expect(committed.record()).toMatchObject({ state: "completed", committed: true });
    expect(committed.discards).toEqual(["container-a"]);
    expect(committed.calls).toEqual([]);

    const open = rig(at("committing", swapped));
    expect(await open.run()).toBe("rolling_back");
    for (let i = 0; i < 300 && open.record()?.state !== "idle"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(open.record()).toMatchObject({ state: "idle", error: { code: "UPDATER_RESTARTED" }, committed: false });
    expect(open.discards).toEqual([]);
  });

  it("goes on with a way back that was going on, from its beginning", async () => {
    const r = rig({ ...at("verifying", swapped), state: "rolling_back", error: { code: "START_TIMEOUT" } } as ReturnType<typeof at>);
    expect(await r.run()).toBe("rolling_back");
    for (let i = 0; i < 300 && r.record()?.state !== "idle"; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(r.record()).toMatchObject({ state: "idle", error: { code: "START_TIMEOUT" } });
    expect(r.calls[0]).toBe("retireReplacement container-a container-b");
  });

  it("says that the journal cannot be read and touches nothing, so nothing opens", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "recover-"));
    writeFileSync(path.join(dir, "update-state.json"), "garbage");
    const journal = openJournal(dir);
    const calls: string[] = [];
    const rollback = createRollbackRunner({ journal, controlDir: dir, scope: fakeRollbackScope(calls), nowIso: () => now, logger: { log: () => undefined } });
    expect(await recoverOnStart({ journal, rollback, switcher: { watch: () => undefined }, discardPrevious: async () => undefined, nowIso: () => now, logger: { log: () => undefined } })).toBe("unreadable");
    expect(calls).toEqual([]);
  });
});
