// D29.1 — the copy `pre_type_change` as the first phase of the operation of a change of type
// (Architektura §5.2, §11.3.1, §11.4, §18.4), on a real installation: its writer lease, its gate file,
// its database and its folder of copies, with `pomiary` (text 12 and abc) made through the API.
// AC1: S9 text → number: the gate is in the phase `snapshot`, then `rebuilding` with the copy's ID; the
//      published package verifies, has the reason `pre_type_change` and the operation's ID, and its
//      database has 12 and abc as text at schema revision 1; after the change 12 is a number and abc
//      empty, and the operation is closed.
// AC2: a copy that fails or has too little room leaves the unit unstarted, the database as it was and
//      no package; an active operation is MAINTENANCE; a record written after the copy and before the unit
//      makes the plan stale and stays; a start with the phase `snapshot` left active closes it at the revision it
//      started from and discards the staging, one above refuses the start.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { databaseSnapshotMetaSchema } from "@openlife/contracts/backups/database-snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDatabaseSnapshot } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { createStructurePlanSigner } from "../../../apps/server/dist/adapters/structure-plan-signer.js";
import { createRebuildOperation } from "../../../apps/server/dist/workers/rebuild-operation.js";
import { canonicalChange, DEFAULT_REGISTRY_LIMITS, STRUCTURE_PLAN_TTL_MS } from "../../../packages/core/dist/modules/registries/public.js";
import { execute, query, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { backupsDir, databaseFile, packages, restoredRows, sha256, stagingEntries, stateFile } from "../../support/database-fixtures.ts";
import { closeWriters, stopped, writerOf, type WriterOptions } from "../../support/rebuild-writer.ts";
import { outputEvent, runServerEntry } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

type GateState = { formatVersion: number; generation: number; activeOperation: Record<string, unknown> | null };
const readGate = (setup: Installation): GateState => JSON.parse(readFileSync(stateFile(setup.instance), "utf8")) as GateState;
const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const KEY = "c4".repeat(32);
const change = (columnId: string) => ({ kind: "changeType", columnId, type: "number" });

/** The operation of a change of type on the writer of a stopped installation, and a plan of its preview. */
function typeChange(setup: Installation, registry: { id: string; columnId: string; ownerId: string }, options: WriterOptions = {}) {
  const writer = writerOf(setup, options);
  let unitRuns = 0;
  const unit = {
    read: writer.unit.read.bind(writer.unit),
    run: ((work) => {
      unitRuns += 1;
      return writer.unit.run(work);
    }) as typeof writer.unit.run,
  };
  const signer = createStructurePlanSigner(KEY);
  const operation = createRebuildOperation({ gate: writer.gate, unit, snapshots: writer.snapshots, change: { signer, limits: DEFAULT_REGISTRY_LIMITS }, nowMs: Date.now, newOperationId: randomUUID });
  const planToken = signer.issue({ registryId: registry.id, schemaRevision: 1, dataRevision: 2, expiresAtMs: Date.now() + STRUCTURE_PLAN_TTL_MS }, { ownerId: registry.ownerId, change: canonicalChange(change(registry.columnId)) });
  const run = (requestId: string) => operation({ ownerId: registry.ownerId, symbol: "pomiary", change: change(registry.columnId), planToken, requestId });
  return { ...writer, run, unitRuns: () => unitRuns };
}

/** Everything the change could touch, as one text. */
const state = (setup: Installation) =>
  JSON.stringify([query(setup.instance, "SELECT * FROM registry"), query(setup.instance, "SELECT * FROM registry_column"), query(setup.instance, "SELECT * FROM reg_pomiary ORDER BY id"), query(setup.instance, "SELECT sql FROM sqlite_master ORDER BY name"), query(setup.instance, "SELECT action FROM audit_log ORDER BY rowid")]);

describe("D29.1-AC1 the copy pre_type_change is taken before the rebuild, in the same operation", () => {
  it("S9: the gate shows the phase snapshot and then rebuilding with the copy; the copy verifies and holds the registry before the change", async () => {
    const { setup, registry } = await stopped("d29-1");
    const generation = readGate(setup).generation;
    const seen: GateState[] = [];
    const writer = typeChange(setup, registry, {
      snapshots: (inner) => ({ ...inner, create: (request) => (seen.push(readGate(setup)), inner.create(request)) }),
      rebuild: (inner) => ({ rebuild: (...args) => (seen.push(readGate(setup)), inner.rebuild(...args)) }),
    });

    const result = await writer.run("req-d29-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.value).toEqual({ registryId: registry.id, schemaRevision: 2, rows: 2, failed: 1 });
    const { snapshotId } = result.value;
    const [during, rebuilding] = seen;
    expect(during).toMatchObject({ generation: generation + 1, activeOperation: { reason: "rebuild", phase: "snapshot", snapshotId: null, registryId: registry.id, fromSchemaRevision: 1 } });
    expect(rebuilding).toMatchObject({ generation: generation + 1, activeOperation: { operationId: (during!.activeOperation as { operationId: string }).operationId, phase: "rebuilding", snapshotId } });
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });

    const [pkg, ...others] = packages(setup.instance);
    expect(others).toEqual([]);
    expect(verifyDatabaseSnapshot(pkg!)).toMatchObject({ ok: true });
    const meta = databaseSnapshotMetaSchema.parse(JSON.parse(readFileSync(path.join(pkg!, "meta.json"), "utf8")));
    expect(meta).toMatchObject({ snapshotId, reason: "pre_type_change", operationId: (during!.activeOperation as { operationId: string }).operationId, instanceId: setup.instance.instanceId });
    expect(restoredRows(pkg!, "SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: "12" }, { wynik: "abc" }]);
    expect(restoredRows(pkg!, "SELECT schema_revision FROM registry")).toEqual([{ schema_revision: 1 }]);
    expect(query(setup.instance, "SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: 12 }, { wynik: null }]);
  });
});

describe("D29.1-AC2 no copy, no change; and what happens while the copy is made", () => {
  it("a copy that fails or has too little room starts no unit, changes nothing, publishes nothing and closes the operation", async () => {
    const { setup, registry } = await stopped("d29-1-failed");
    const generation = readGate(setup).generation;
    const before = state(setup);

    const failing = typeChange(setup, registry, { snapshots: (inner) => ({ ...inner, create: async () => ({ ok: false, code: "SNAPSHOT_FAILED" }) }) });
    expect(await failing.run("req-failed")).toEqual({ ok: false, error: { code: "SNAPSHOT_FAILED" } });
    expect(failing.unitRuns()).toBe(0);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
    closeWriters();

    // backup.diskReserveMiB above any free space: the adapter refuses before it copies.
    const full = typeChange(setup, registry, { reserveMiB: Number.MAX_SAFE_INTEGER / (1024 * 1024) });
    expect(await full.run("req-low-space")).toEqual({ ok: false, error: { code: "SNAPSHOT_LOW_SPACE" } });
    expect(full.unitRuns()).toBe(0);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 2, activeOperation: null });
    expect(state(setup)).toBe(before);
    expect(packages(setup.instance)).toEqual([]);
  });

  it("an active operation is MAINTENANCE and changes nothing; a record written after the copy and before the rebuild makes the plan stale and stays", async () => {
    const { setup, registry } = await stopped("d29-1-meanwhile");
    // A second change asked for while the copy of the first is being made meets its operation.
    let second: unknown = null;
    const writer = typeChange(setup, registry, {
      snapshots: (inner) => ({
        ...inner,
        create: async (request) => {
          second = await writer.run("req-second");
          const made = await inner.create(request);
          // A record of the registry written after the copy and before the unit, as a request of the server could.
          writer.connection.handle.prepare("INSERT INTO reg_pomiary (id, user_id, created_at, updated_at, revision, wynik) SELECT 'rec-meanwhile', user_id, created_at, updated_at, 1, 'nowy' FROM reg_pomiary LIMIT 1").run();
          writer.connection.handle.prepare("UPDATE registry SET data_revision = data_revision + 1").run();
          return made;
        },
      }),
    });
    const generation = readGate(setup).generation;

    expect(await writer.run("req-first")).toEqual({ ok: false, error: { code: "PLAN_STALE" } });
    expect(second).toEqual({ ok: false, error: { code: "MAINTENANCE" } });
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
    expect(query(setup.instance, "SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: "12" }, { wynik: "abc" }, { wynik: "nowy" }]);
    expect(query(setup.instance, "SELECT schema_revision FROM registry")).toEqual([{ schema_revision: 1 }]);
    // The copy was made and published; only the rebuild did not run.
    expect(packages(setup.instance)).toHaveLength(1);
  });
});

describe("D29.1-AC2 a change of type left in the phase snapshot by a crash", () => {
  function crashedInSnapshot(setup: Installation, registryId: string): void {
    const gate = readGate(setup);
    writeFileSync(
      stateFile(setup.instance),
      JSON.stringify({ formatVersion: 1, generation: gate.generation + 1, activeOperation: { operationId: randomUUID(), reason: "rebuild", phase: "snapshot", startedAt: new Date().toISOString(), registryId, fromSchemaRevision: 1, snapshotId: null } }),
    );
    // What a crash while staging the copy leaves.
    mkdirSync(path.join(backupsDir(setup.instance), ".staging", "20261102T000000Z-pre_type_change-left"), { recursive: true });
  }

  it("at the revision it started from the operation closes and the staging is discarded; one above refuses the start", async () => {
    const { setup, registry } = await stopped("d29-1-crash");
    const generation = readGate(setup).generation;
    crashedInSnapshot(setup, registry.id);
    const server = await serve(setup.instance);
    expect(outputEvent(server.output(), "bootstrap.ready")).toMatchObject({ maintenance: { generation: generation + 1 } });
    await stopServer(server);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
    expect(stagingEntries(setup.instance)).toEqual([]);

    // In the phase snapshot the unit had not begun: a registry one revision above is not explained by it.
    execute(setup.instance, "UPDATE registry SET schema_revision = 2");
    crashedInSnapshot(setup, registry.id);
    const gate = readFileSync(stateFile(setup.instance), "utf8");
    const database = sha256(databaseFile(setup.instance));
    const exit = await runServerEntry(["--port", "0", "--installation", setup.instance.dir], processEnv(setup));
    expect(exit.code, exit.output).toBe(1);
    expect(outputEvent(exit.output, "bootstrap.failed")).toEqual({ event: "bootstrap.failed", code: "MAINTENANCE_RECOVERY_REQUIRED", fields: ["activeOperation"] });
    expect(readFileSync(stateFile(setup.instance), "utf8")).toBe(gate);
    expect(sha256(databaseFile(setup.instance))).toBe(database);
  });
});
