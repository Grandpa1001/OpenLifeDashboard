// D30.1 — the deletion of a registry as an operation of the maintenance gate (Architektura §4.8,
// §5.2, §11.4), on a real installation: its writer lease, its gate file, its database and its folder of
// copies, with `pomiary` made through the API.
// AC2: a failure after the drop of the table or after the catalog takes the whole unit back (the table,
//      its rows and the catalog as they were); a start with a `rebuild` left active after a committed
//      deletion closes it, a registry deleted at the revision the operation started from refuses the start.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createStructurePlanSigner } from "../../../apps/server/dist/adapters/structure-plan-signer.js";
import { canonicalChange, DEFAULT_REGISTRY_LIMITS, STRUCTURE_PLAN_TTL_MS } from "../../../packages/core/dist/modules/registries/public.js";
import { execute, query, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { databaseFile, sha256, stateFile } from "../../support/database-fixtures.ts";
import { closeWriters, createDeletionOperation, stopped, writerOf, type WriterOptions } from "../../support/rebuild-writer.ts";
import { outputEvent, runServerEntry } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

type GateState = { formatVersion: number; generation: number; activeOperation: Record<string, unknown> | null };
const readGate = (setup: Installation): GateState => JSON.parse(readFileSync(stateFile(setup.instance), "utf8")) as GateState;
const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const KEY = "d3".repeat(32);
const DELETION = { kind: "deleteRegistry" };

function deletion(setup: Installation, registry: { id: string; ownerId: string }, options: WriterOptions = {}) {
  const writer = writerOf(setup, options);
  const signer = createStructurePlanSigner(KEY);
  const operation = createDeletionOperation({ gate: writer.gate, unit: writer.unit, snapshots: writer.snapshots, change: { signer, limits: DEFAULT_REGISTRY_LIMITS }, nowMs: Date.now, newOperationId: randomUUID });
  const planToken = signer.issue({ registryId: registry.id, schemaRevision: 1, dataRevision: 2, expiresAtMs: Date.now() + STRUCTURE_PLAN_TTL_MS }, { ownerId: registry.ownerId, change: canonicalChange(DELETION) });
  return (requestId: string) => operation({ ownerId: registry.ownerId, symbol: "pomiary", change: DELETION, planToken, requestId });
}

const state = (setup: Installation) =>
  JSON.stringify([query(setup.instance, "SELECT * FROM registry"), query(setup.instance, "SELECT * FROM registry_column"), query(setup.instance, "SELECT * FROM reg_pomiary ORDER BY id"), query(setup.instance, "SELECT sql FROM sqlite_master ORDER BY name"), query(setup.instance, "SELECT action FROM audit_log ORDER BY rowid")]);

describe("D30.1-AC2 a deletion fails as a whole", () => {
  it("a failure after the drop of the table or after the catalog leaves the table, its rows and the catalog as they were", async () => {
    const { setup, registry } = await stopped("d30-1-stages");
    const before = state(setup);
    const generation = readGate(setup).generation;

    const afterDrop = deletion(setup, registry, { tables: (inner) => ({ ...inner, drop: (target) => (inner.drop(target), (() => { throw new Error("failed after the drop"); })()) }) });
    await expect(afterDrop("req-after-drop")).rejects.toThrow(/after the drop/);
    closeWriters();
    expect(state(setup)).toBe(before);

    const afterCatalog = deletion(setup, registry, { registries: (inner) => ({ ...inner, markDeleted: (target, nowIso) => (inner.markDeleted(target, nowIso), (() => { throw new Error("failed after the catalog"); })()) }) });
    await expect(afterCatalog("req-after-catalog")).rejects.toThrow(/after the catalog/);
    closeWriters();
    expect(state(setup)).toBe(before);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 2, activeOperation: null });
  });
});

describe("D30.1-AC2 a deletion left active by a crash is reconciled at the next start", () => {
  function crashedDuring(setup: Installation, registryId: string): void {
    const gate = readGate(setup);
    writeFileSync(stateFile(setup.instance), JSON.stringify({ formatVersion: 1, generation: gate.generation + 1, activeOperation: { operationId: randomUUID(), reason: "rebuild", phase: "rebuilding", startedAt: new Date().toISOString(), registryId, fromSchemaRevision: 1, snapshotId: randomUUID() } }));
  }

  it("after a committed deletion the operation closes and the server is ready; a registry deleted at the revision it started from refuses the start", async () => {
    const { setup, registry } = await stopped("d30-1-crash");
    const run = deletion(setup, registry);
    expect(await run("req-d30-1")).toMatchObject({ ok: true, value: { value: { registryId: registry.id, schemaRevision: 2, affected: 2 } } });
    closeWriters();
    const generation = readGate(setup).generation;

    // The unit committed; only closing the operation was lost.
    crashedDuring(setup, registry.id);
    const server = await serve(setup.instance);
    expect(outputEvent(server.output(), "bootstrap.ready")).toMatchObject({ maintenance: { generation: generation + 1 } });
    await stopServer(server);
    expect(readGate(setup)).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });

    // Deleted but at the revision the operation started from: not a state a deletion leaves.
    execute(setup.instance, "UPDATE registry SET schema_revision = 1");
    crashedDuring(setup, registry.id);
    const gate = readFileSync(stateFile(setup.instance), "utf8");
    const database = sha256(databaseFile(setup.instance));
    const exit = await runServerEntry(["--port", "0", "--installation", setup.instance.dir], processEnv(setup));
    expect(exit.code, exit.output).toBe(1);
    expect(outputEvent(exit.output, "bootstrap.failed")).toEqual({ event: "bootstrap.failed", code: "MAINTENANCE_RECOVERY_REQUIRED", fields: ["activeOperation"] });
    expect(readFileSync(stateFile(setup.instance), "utf8")).toBe(gate);
    expect(sha256(databaseFile(setup.instance))).toBe(database);
  });
});
