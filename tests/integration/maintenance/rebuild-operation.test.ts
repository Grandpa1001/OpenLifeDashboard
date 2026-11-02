// D27.2 — the rebuild of a registry's table as an operation of the maintenance gate (Architektura
// §4.8, §11.4, §18.4), on a real installation: its writer lease, its gate file and its database, with
// the registry made through the API of the built server.
// AC1: the operation records `rebuild` in the gate while its unit runs and closes it after, one
//      generation later; a CLI started while the writer is held is INSTANCE_BUSY and changes nothing;
//      a refused plan and a failing unit close the operation with the database unchanged.
// AC2: a start with a `rebuild` left active closes it when the registry is at the revision it started
//      from or one above and is then ready; another revision, an unknown registry and a table of a
//      rebuild left behind refuse the start with MAINTENANCE_RECOVERY_REQUIRED and change nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createStructurePlanSigner } from "../../../apps/server/dist/adapters/structure-plan-signer.js";
import { createRebuildOperation } from "../../../apps/server/dist/workers/rebuild-operation.js";
import { canonicalChange, DEFAULT_REGISTRY_LIMITS, STRUCTURE_PLAN_TTL_MS, type StoredRegistry, type TableRebuild } from "../../../packages/core/dist/modules/registries/public.js";
import { execute, query, RESET_PASSWORD, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { databaseFile, sha256, stateFile } from "../../support/database-fixtures.ts";
import { closeWriters, stopped, writerOf } from "../../support/rebuild-writer.ts";
import { outputEvent, runBuiltScript, runServerEntry } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

type GateState = { formatVersion: number; generation: number; activeOperation: Record<string, unknown> | null };
const readGate = (setup: Installation): GateState => JSON.parse(readFileSync(stateFile(setup.instance), "utf8")) as GateState;
const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const signer = (keyHex: string) => createStructurePlanSigner(keyHex);

const change = (columnId: string) => ({ kind: "changeType", columnId, type: "number" });

describe("D27.2-AC1 the rebuild is an operation of the gate under the writer lease", () => {
  it("records rebuild while the unit runs and closes it one generation later; a CLI meanwhile is INSTANCE_BUSY", async () => {
    const { setup, registry } = await stopped("d27-2");
    const generation = readGate(setup).generation;
    const key = "ef".repeat(32);
    const { gate, unit, snapshots } = writerOf(setup);
    let during: GateState | null = null;
    const observed = {
      read: unit.read.bind(unit),
      run: ((work) => {
        during = readGate(setup);
        return unit.run(work);
      }) as typeof unit.run,
    };
    const operation = createRebuildOperation({ gate, unit: observed, snapshots, change: { signer: signer(key), limits: DEFAULT_REGISTRY_LIMITS }, nowMs: Date.now, newOperationId: randomUUID });
    const current = observed.read((ports) => ports.registries.find(registry.ownerId, "pomiary")) as StoredRegistry;
    const planToken = signer(key).issue({ registryId: current.id, schemaRevision: 1, dataRevision: 2, expiresAtMs: Date.now() + STRUCTURE_PLAN_TTL_MS }, { ownerId: registry.ownerId, change: canonicalChange(change(registry.columnId)) });

    // The writer is held by this process: the CLI is refused before it opens the database.
    const before = sha256(databaseFile(setup.instance));
    const busy = await runBuiltScript(RESET_PASSWORD, ["--installation", setup.instance.dir], processEnv(setup), JSON.stringify({ password: "another passphrase of twelve" }));
    expect(busy.code).toBe(1);
    expect(outputEvent(busy.output, "reset-password.failed")).toEqual({ event: "reset-password.failed", code: "INSTANCE_BUSY", fields: ["writer.lock"] });
    expect(sha256(databaseFile(setup.instance))).toBe(before);

    const result = await operation({ ownerId: registry.ownerId, symbol: "pomiary", change: change(registry.columnId), planToken, requestId: "req-d27-2" });
    expect(result).toEqual({ ok: true, value: { value: { registryId: registry.id, schemaRevision: 2, rows: 2, failed: 1 }, snapshotId: expect.any(String) } });
    expect(during).toMatchObject({ generation: generation + 1, activeOperation: { reason: "rebuild", phase: "rebuilding", registryId: registry.id, fromSchemaRevision: 1 } });
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
    expect(query(setup.instance, "SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: 12 }, { wynik: null }]);
  });

  it("a stale plan and a unit that fails close the operation and leave the database as it was", async () => {
    const { setup, registry } = await stopped("d27-2");
    const generation = readGate(setup).generation;
    const key = "ab".repeat(32);
    const failing = (inner: TableRebuild): TableRebuild => ({ rebuild: (...args) => (inner.rebuild(...args), (() => { throw new Error("the rebuild failed after its stages"); })()) });
    const { gate, unit, snapshots } = writerOf(setup, { rebuild: failing });
    const operation = createRebuildOperation({ gate, unit, snapshots, change: { signer: signer(key), limits: DEFAULT_REGISTRY_LIMITS }, nowMs: Date.now, newOperationId: randomUUID });
    const tokenFor = (dataRevision: number) =>
      signer(key).issue({ registryId: registry.id, schemaRevision: 1, dataRevision, expiresAtMs: Date.now() + STRUCTURE_PLAN_TTL_MS }, { ownerId: registry.ownerId, change: canonicalChange(change(registry.columnId)) });
    const rows = () => JSON.stringify([query(setup.instance, "SELECT * FROM registry"), query(setup.instance, "SELECT * FROM registry_column"), query(setup.instance, "SELECT * FROM reg_pomiary ORDER BY id"), query(setup.instance, "SELECT sql FROM sqlite_master ORDER BY name")]);
    const before = rows();

    expect(await operation({ ownerId: registry.ownerId, symbol: "pomiary", change: change(registry.columnId), planToken: tokenFor(1), requestId: "req-stale" })).toEqual({ ok: false, error: { code: "PLAN_STALE" } });
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
    await expect(operation({ ownerId: registry.ownerId, symbol: "pomiary", change: change(registry.columnId), planToken: tokenFor(2), requestId: "req-failing" })).rejects.toThrow(/after its stages/);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 2, activeOperation: null });
    expect(rows()).toBe(before);
    // An unknown registry is not an operation at all.
    expect(await operation({ ownerId: registry.ownerId, symbol: "nieznany", change: change(registry.columnId), planToken: tokenFor(2), requestId: "req-unknown" })).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(readGate(setup).generation).toBe(generation + 2);
  });
});

describe("D27.2-AC2 a rebuild left active by a crash is reconciled at the next start", () => {
  /** The gate as a crash between `begin` and `complete` leaves it. */
  function crashedDuring(setup: Installation, registryId: string, fromSchemaRevision: number): string {
    const state = readGate(setup);
    const operationId = randomUUID();
    writeFileSync(stateFile(setup.instance), JSON.stringify({ formatVersion: 1, generation: state.generation + 1, activeOperation: { operationId, reason: "rebuild", phase: "rebuilding", startedAt: new Date().toISOString(), registryId, fromSchemaRevision } }));
    return operationId;
  }

  it("at the revision it started from (nothing kept) and one above (committed), the operation closes and the server is ready", async () => {
    const { setup, registry } = await stopped("d27-2");
    const generation = readGate(setup).generation;
    crashedDuring(setup, registry.id, 1);
    const server = await serve(setup.instance);
    expect(outputEvent(server.output(), "bootstrap.ready")).toMatchObject({ maintenance: { generation: generation + 1 } });
    await stopServer(server);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });

    // The transaction committed before the crash: the registry is one revision above.
    execute(setup.instance, "UPDATE registry SET schema_revision = 2");
    crashedDuring(setup, registry.id, 1);
    const again = await serve(setup.instance);
    await stopServer(again);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 2, activeOperation: null });
  });

  it("another revision, an unknown registry and a table of a rebuild left behind refuse the start and change nothing", async () => {
    const { setup, registry } = await stopped("d27-2");
    const refusedStart = async (): Promise<void> => {
      const gate = readFileSync(stateFile(setup.instance), "utf8");
      const database = sha256(databaseFile(setup.instance));
      const exit = await runServerEntry(["--port", "0", "--installation", setup.instance.dir], processEnv(setup));
      expect(exit.code, exit.output).toBe(1);
      expect(outputEvent(exit.output, "bootstrap.failed")).toEqual({ event: "bootstrap.failed", code: "MAINTENANCE_RECOVERY_REQUIRED", fields: ["activeOperation"] });
      expect(readFileSync(stateFile(setup.instance), "utf8")).toBe(gate);
      expect(sha256(databaseFile(setup.instance))).toBe(database);
    };
    const clean = readFileSync(stateFile(setup.instance), "utf8");

    execute(setup.instance, "UPDATE registry SET schema_revision = 3");
    crashedDuring(setup, registry.id, 1);
    await refusedStart();

    writeFileSync(stateFile(setup.instance), clean);
    execute(setup.instance, "UPDATE registry SET schema_revision = 1");
    crashedDuring(setup, "019a0000-0000-7000-8000-00000000dead", 1);
    await refusedStart();

    writeFileSync(stateFile(setup.instance), clean);
    execute(setup.instance, 'CREATE TABLE "reg_pomiary__rebuild" ("id" TEXT PRIMARY KEY) STRICT');
    crashedDuring(setup, registry.id, 1);
    await refusedStart();
  });
});
