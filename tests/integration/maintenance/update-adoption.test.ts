// D55.2 and D55.4 — the new app B takes over the operation of the update, migrates under it and proves itself before it opens anything
// (Architektura §11.2.2 steps 5 to 7; DEV §9.54), on a real gate, a real database and a real copy of it.
// AC1: B finds the operation `update` in `switching` for its own version with the updater in `verifying`, migrates the database of A to
//      its version under the operation with no second copy (the `pre_update` copy of the operation is the one before the migration), leaves
//      the operation on the gate in the phase `verifying`, holds its readiness, and only after the updater has committed closes the
//      operation and gives the readiness back, the writes opening in that order.
// D55.4-AC2: B that went down after it took the operation over and finds the updater past its commit point only closes the operation; before it, it does not start.
// AC2: another version, a copy that is missing or is of another database, an updater that cannot be asked or says another operation,
//      another state or another fence, an operation in another phase, and a migration that fails leave the gate as it was and do not
//      start the app; a proof that is refused or that cannot be made opens nothing.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import type { UpdaterStatus } from "@openlife/contracts/updates/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseSnapshots } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { openMaintenanceGate } from "../../../apps/server/dist/adapters/filesystem/maintenance-gate.js";
import { acquireWriterLease } from "../../../apps/server/dist/adapters/filesystem/writer-lease.js";
import { openInstallationDatabase, type DatabaseOpenInputs } from "../../../apps/server/dist/bootstrap/database.js";
import { createReadiness } from "../../../apps/server/dist/bootstrap/readiness.js";
import { createUpdateAdoption } from "../../../apps/server/dist/workers/update-adoption.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase } from "../../../packages/sqlite/dist/migrations/public.js";
import { scratchDir } from "../../support/scratch.ts";
import { BROKEN_PLAN, PLAN_A, PLAN_B } from "../../support/migration-plans.ts";

const INSTANCE_ID = "5a1e9c47-3b2d-4f60-8c1a-7d4e2b9f0a13";
const TARGET = "1.3.0";
const leases: Array<() => void> = [];
afterEach(() => {
  for (const release of leases.splice(0)) release();
});

type Rig = Awaited<ReturnType<typeof rig>>;

/** An installation of A as the update leaves it when B is started: the database at the old version, its copy `pre_update` taken, the operation in `switching`. */
async function rig(options: { copy?: boolean; phase?: "quiescing" | "switching"; reopenPlan?: DatabaseOpenInputs["plan"] } = {}) {
  const dir = scratchDir("update-adoption-");
  const workingPaths = { maintenance: path.join(dir, "maintenance"), database: path.join(dir, "app.db"), backups: path.join(dir, "backup") };
  mkdirSync(workingPaths.maintenance);
  mkdirSync(workingPaths.backups);
  const writer = acquireWriterLease(workingPaths.maintenance);
  if (!writer.ok) throw new Error("no lease");
  leases.push(() => writer.lease.release());
  const gate = openMaintenanceGate(writer.lease, workingPaths);
  if (!gate.ok) throw new Error("no gate");
  const snapshotOptions = { backupsDir: workingPaths.backups, reserveMiB: 0, instanceId: INSTANCE_ID, build: { appVersion: "1.2.3", buildRevision: "test", imageDigest: null }, now: () => new Date().toISOString(), newSnapshotId: randomUUID };
  const connection = openDatabase(workingPaths.database, { role: "writer", busyTimeoutMs: 5000 });
  initializeDatabase(connection, PLAN_A, { instanceId: INSTANCE_ID, createdAt: new Date().toISOString() });
  const operationId = randomUUID();
  const begun = gate.gate.begin({ operationId, reason: "update", phase: "quiescing", startedAt: new Date().toISOString(), targetRelease: TARGET });
  if (options.copy !== false) {
    const copy = await createDatabaseSnapshots(connection, snapshotOptions).create({ reason: "pre_update", scope: "database", operationId, fence: begun.generation });
    if (!copy.ok) throw new Error("no copy");
  }
  gate.gate.advance({ operationId, reason: "update", phase: options.phase ?? "switching", startedAt: begun.activeOperation!.startedAt, targetRelease: TARGET });
  connection.close();

  let asked = 0;
  const statusOf = (over: Partial<UpdaterStatus> = {}): UpdaterStatus => ({ state: "verifying", operationId, fence: begun.generation, targetRelease: TARGET, committed: false, error: null, app: null, ...over });
  const state: { status: UpdaterStatus | null } = { status: statusOf() };
  const inputs = (over: Partial<DatabaseOpenInputs> = {}): DatabaseOpenInputs => ({
    file: workingPaths.database,
    gate: gate.gate,
    plan: options.reopenPlan ?? PLAN_B,
    instanceId: INSTANCE_ID,
    busyTimeoutMs: 5000,
    createSnapshots: (source) => createDatabaseSnapshots(source, snapshotOptions),
    now: () => new Date().toISOString(),
    newOperationId: randomUUID,
    update: { appVersion: TARGET, status: async () => { asked += 1; return state.status; } },
    ...over,
  });
  return { dir, workingPaths, gate: gate.gate, operationId, fence: begun.generation, state, statusOf, inputs, asked: () => asked, packages: () => readdirSync(workingPaths.backups).filter((name) => !name.startsWith(".")) };
}

const tables = (file: string): string[] => {
  const reader = openDatabase(file, { role: "reader", busyTimeoutMs: 5000 });
  try {
    return (reader.handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    reader.close();
  }
};
const noteTable = (file: string): boolean => tables(file).includes("harness_note");

describe("D55.2-AC1 B takes the operation over, migrates under it with the copy of A and opens nothing before the commit", () => {
  it("migrates to its version with no second copy, leaves the operation on the gate in verifying and tells the update it holds", async () => {
    const r = await rig();
    const copies = r.packages();
    expect(copies).toHaveLength(1);
    expect(noteTable(r.workingPaths.database)).toBe(false);
    const result = await openInstallationDatabase(r.inputs());
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    result.connection.close();
    expect(result.update).toEqual({ operationId: r.operationId, fence: r.fence });
    expect(noteTable(r.workingPaths.database)).toBe(true);
    // The copy of the operation is the only one: the copy before the migration is the `pre_update` copy of A.
    expect(r.packages()).toEqual(copies);
    expect(r.gate.current()).toMatchObject({ generation: r.fence, activeOperation: { operationId: r.operationId, reason: "update", phase: "verifying", targetRelease: TARGET } });
  });

  it("takes a release with no migration over as well, and still leaves the operation open", async () => {
    const r = await rig({ reopenPlan: PLAN_A });
    const result = await openInstallationDatabase(r.inputs());
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    result.connection.close();
    expect(result.update).toBeDefined();
    expect(r.gate.current().activeOperation).toMatchObject({ reason: "update", phase: "verifying" });
  });

  it("holds the readiness, tells the updater what it is, and opens the operation and the readiness only after the commit, in that order", async () => {
    const r = await rig();
    const opened = await openInstallationDatabase(r.inputs());
    if (!opened.ok || opened.update === undefined) throw new Error("not adopted");
    opened.connection.close();
    const readiness = createReadiness();
    readiness.hold();
    const events: string[] = [];
    const sent: unknown[] = [];
    let polls = 0;
    const adoption = createUpdateAdoption({
      updater: {
        send: async (command) => {
          sent.push(command);
          events.push("ready sent");
          return { kind: "accepted", body: {} };
        },
        status: async () => {
          polls += 1;
          events.push(`status ${polls}`);
          return r.statusOf({ committed: polls >= 3, state: polls >= 3 ? "completed" : "committing" });
        },
      },
      gate: { complete: (id, fence) => { events.push(`gate closed ${readiness.isReady() ? "after" : "before"} the readiness`); r.gate.complete(id, fence); return r.gate.current(); } },
      readiness: { release: () => { events.push("readiness given back"); readiness.release(); } },
      selfCheck: () => true,
      appVersion: TARGET,
      schemaVersion: opened.schemaVersion,
      update: opened.update,
      logger: { log: () => undefined },
      pollMs: 5,
    });
    expect(readiness.isReady()).toBe(false);
    expect(await adoption.run()).toBe("committed");
    expect(sent).toEqual([{ type: "ready", fence: r.fence, appVersion: TARGET, schemaVersion: opened.schemaVersion }]);
    expect(events).toEqual(["ready sent", "status 1", "status 2", "status 3", "gate closed before the readiness", "readiness given back"]);
    expect(readiness.isReady()).toBe(true);
    expect(r.gate.current().activeOperation).toBeNull();
  });
});

describe("D55.4-AC2 the new app that went down after taking the operation over", () => {
  /** The state after B adopted the operation and went down before it closed it: the database is B's, the operation is in `verifying`. */
  async function afterTheFall() {
    const r = await rig();
    const opened = await openInstallationDatabase(r.inputs());
    if (!opened.ok) throw new Error("not adopted");
    opened.connection.close();
    return r;
  }

  it("after the commit point only closes the operation, opens no hold and keeps the migrated data", async () => {
    const r = await afterTheFall();
    r.state.status = r.statusOf({ state: "completed", committed: true });
    const result = await openInstallationDatabase(r.inputs());
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    result.connection.close();
    expect(result.update).toBeUndefined();
    expect(r.gate.current()).toMatchObject({ generation: r.fence, activeOperation: null });
    expect(noteTable(r.workingPaths.database)).toBe(true);
  });

  it("before the commit point does not start and leaves the operation, for the way back", async () => {
    const r = await afterTheFall();
    for (const status of [r.statusOf({ state: "verifying" }), r.statusOf({ state: "committing", committed: false }), null, r.statusOf({ operationId: randomUUID(), committed: true }), r.statusOf({ fence: r.fence + 1, committed: true })]) {
      r.state.status = status;
      const result = await openInstallationDatabase(r.inputs());
      expect(result.ok ? "started" : result.code, JSON.stringify(status)).toBe("MAINTENANCE_RECOVERY_REQUIRED");
      expect(r.gate.current().activeOperation).toMatchObject({ reason: "update", phase: "verifying" });
    }
  });

  it("does not close the operation over a database that is not at its version", async () => {
    const r = await rig();
    // The operation stands in `verifying` (as after an adoption) while the database is still A's: the commit point cannot be of this data.
    r.gate.advance({ operationId: r.operationId, reason: "update", phase: "verifying", startedAt: r.gate.current().activeOperation!.startedAt, targetRelease: TARGET });
    r.state.status = r.statusOf({ state: "completed", committed: true });
    const result = await openInstallationDatabase(r.inputs());
    expect(result.ok ? "started" : result.code).toBe("MAINTENANCE_RECOVERY_REQUIRED");
    expect(r.gate.current().activeOperation).toMatchObject({ phase: "verifying" });
  });
});

describe("D55.2-AC2 whatever does not agree leaves the gate as it was and the app does not start", () => {
  const refused = async (r: Rig, over: Partial<DatabaseOpenInputs> = {}): Promise<string> => {
    const before = JSON.stringify(r.gate.current());
    const result = await openInstallationDatabase(r.inputs(over));
    if (result.ok) {
      result.connection.close();
      throw new Error("was adopted");
    }
    expect(JSON.stringify(r.gate.current())).toBe(before);
    expect(noteTable(r.workingPaths.database)).toBe(false);
    return result.code;
  };

  it("does not take the operation over for another version, without an updater to ask, or in another phase", async () => {
    const r = await rig();
    expect(await refused(r, { update: { appVersion: "1.2.3", status: async () => r.state.status } })).toBe("MAINTENANCE_RECOVERY_REQUIRED");
    const { update: _withUpdater, ...withoutUpdater } = r.inputs();
    void _withUpdater;
    const before = JSON.stringify(r.gate.current());
    const bare = await openInstallationDatabase(withoutUpdater);
    expect(bare.ok ? "adopted" : bare.code).toBe("MAINTENANCE_RECOVERY_REQUIRED");
    expect(JSON.stringify(r.gate.current())).toBe(before);
    const early = await rig({ phase: "quiescing" });
    expect(await refused(early)).toBe("MAINTENANCE_RECOVERY_REQUIRED");
    expect(early.asked()).toBe(0);
  });

  it("does not take it over when the updater cannot be asked, says another operation, another state or another fence", async () => {
    const r = await rig();
    for (const status of [null, r.statusOf({ operationId: randomUUID() }), r.statusOf({ state: "switching" }), r.statusOf({ state: "idle" }), r.statusOf({ fence: r.fence + 1 }), r.statusOf({ operationId: null })]) {
      r.state.status = status;
      expect(await refused(r), JSON.stringify(status)).toBe("MAINTENANCE_RECOVERY_REQUIRED");
    }
  });

  it("does not migrate without the copy of the operation, nor with a copy of another database", async () => {
    const none = await rig({ copy: false });
    expect(await refused(none)).toBe("MIGRATION_SNAPSHOT_REQUIRED");
    // The copy of the operation is of the schema of A; a database that is already at the new version is not the one it was taken of.
    const other = await rig();
    const warmed = await openInstallationDatabase(other.inputs());
    if (!warmed.ok) throw new Error("not adopted");
    warmed.connection.close();
    // The operation is now in verifying: a start that finds it there is not an adoption either.
    expect(await openInstallationDatabase(other.inputs()).then((result) => (result.ok ? "adopted" : result.code))).toBe("MAINTENANCE_RECOVERY_REQUIRED");
  });

  it("leaves the operation and the database at A when the migration fails", async () => {
    const r = await rig({ reopenPlan: BROKEN_PLAN });
    const result = await openInstallationDatabase(r.inputs());
    expect(result.ok ? "adopted" : result.code).toBe("MIGRATION_FAILED");
    // The migration was one transaction: the database is A's, and the operation stays on the gate, in the phase it reached, for the way back (D56).
    expect(tables(r.workingPaths.database)).not.toContain("harness_ok");
    expect(r.gate.current().activeOperation).toMatchObject({ operationId: r.operationId, reason: "update", phase: "migrating" });
    expect(r.packages()).toHaveLength(1);
  });

  it("opens nothing when the proof is refused, cannot be made or cannot be told, and when the commit does not come", async () => {
    const r = await rig();
    const opened = await openInstallationDatabase(r.inputs());
    if (!opened.ok || opened.update === undefined) throw new Error("not adopted");
    opened.connection.close();
    const readiness = createReadiness();
    readiness.hold();
    const make = (over: Partial<Parameters<typeof createUpdateAdoption>[0]> = {}) =>
      createUpdateAdoption({
        updater: { send: async () => ({ kind: "accepted", body: {} }), status: async () => r.statusOf({ state: "committing" }) },
        gate: { complete: r.gate.complete },
        readiness,
        selfCheck: () => true,
        appVersion: TARGET,
        schemaVersion: opened.schemaVersion,
        update: opened.update!,
        logger: { log: () => undefined },
        pollMs: 5,
        waitMs: 60,
        ...over,
      });
    const stays = (): void => {
      expect(readiness.isReady()).toBe(false);
      expect(r.gate.current().activeOperation).toMatchObject({ reason: "update", phase: "verifying" });
    };
    expect(await make({ selfCheck: () => false }).run()).toBe("failed");
    expect(await make({ selfCheck: () => { throw new Error("no"); } }).run()).toBe("failed");
    expect(await make({ updater: { send: async () => ({ kind: "refused", httpStatus: 409, code: "WRONG_STATE", state: "verifying" }), status: async () => null } }).run()).toBe("failed");
    expect(await make({ updater: { send: async () => ({ kind: "unreachable" }), status: async () => null } }).run()).toBe("failed");
    expect(await make().run()).toBe("failed");
    expect(await make({ updater: { send: async () => ({ kind: "accepted", body: {} }), status: async () => r.statusOf({ state: "rolling_back" }) } }).run()).toBe("failed");
    expect(await make({ updater: { send: async () => ({ kind: "accepted", body: {} }), status: async () => r.statusOf({ operationId: randomUUID(), committed: true }) } }).run()).toBe("failed");
    stays();
  });
});
