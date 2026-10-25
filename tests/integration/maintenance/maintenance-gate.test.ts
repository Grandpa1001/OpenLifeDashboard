// D04.1-AC2 — the durable maintenance gate control/maintenance/state.json, separate from the
// lease. A new installation gets generation 0; a restart keeps it. An operation begun by a
// writer that is then SIGKILLed keeps every later start closed with
// MAINTENANCE_RECOVERY_REQUIRED, although the lease itself is recovered; so does an unknown,
// unreadable or missing gate next to an existing database. Refusals change no file.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openMaintenanceGate } from "../../../apps/server/dist/adapters/filesystem/maintenance-gate.js";
import { installationWorkingPaths } from "../../../apps/server/dist/adapters/filesystem/installation-paths.js";
import { acquireWriterLease } from "../../../apps/server/dist/adapters/filesystem/writer-lease.js";
import {
  freshTestInstance,
  outputEvent,
  runServerEntry,
  startBuiltServer,
  startWriterHolder,
  waitForExit,
} from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const STOP_TIMEOUT_MS = 15_000;
const processEnv = (instance: TestInstance) => ({ PATH: process.env["PATH"] ?? "", ...instance.env });
const stateFile = (instance: TestInstance): string => path.join(instance.dir, "control", "maintenance", "state.json");
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const readState = (instance: TestInstance): unknown => JSON.parse(readFileSync(stateFile(instance), "utf8"));

async function bootReady(instance: TestInstance): Promise<unknown> {
  const server = await startBuiltServer({ installation: instance });
  server.child.kill("SIGTERM");
  const exit = await waitForExit(server.child, server.output, STOP_TIMEOUT_MS);
  expect(exit.code).toBe(0);
  return outputEvent(exit.output, "bootstrap.ready")?.["maintenance"];
}

async function bootRefused(instance: TestInstance): Promise<unknown> {
  const exit = await runServerEntry(["--port", "0", "--installation", instance.dir], processEnv(instance));
  expect(exit.code, exit.output).toBe(1);
  expect(exit.output).not.toContain('"server.listening"');
  return outputEvent(exit.output, "bootstrap.failed");
}

const recoveryRequired = (fields: string[]) => ({ event: "bootstrap.failed", code: "MAINTENANCE_RECOVERY_REQUIRED", fields });

/** A valid gate with one field replaced, written as the given text or JSON value. */
function writeGate(instance: TestInstance, content: unknown): void {
  writeFileSync(stateFile(instance), typeof content === "string" ? content : JSON.stringify(content));
}

describe("D04.1-AC2 durable gate across restarts", () => {
  it("a new installation initializes generation 0 and a restart keeps it", async () => {
    const instance = freshTestInstance();
    expect(await bootReady(instance)).toEqual({ generation: 0, initialized: true });
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 0, activeOperation: null });
    const before = sha256(stateFile(instance));
    expect(await bootReady(instance)).toEqual({ generation: 0, initialized: false });
    expect(sha256(stateFile(instance))).toBe(before);
  });

  it("an operation begun by a killed writer blocks later starts although the lease is recovered", async () => {
    const instance = freshTestInstance();
    await bootReady(instance);
    const holder = await startWriterHolder(instance.dir, ["--begin"]);
    expect(holder.ready.generation).toBe(1);
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child, () => "", STOP_TIMEOUT_MS);

    const persisted = readState(instance);
    expect(persisted).toMatchObject({ generation: 1, activeOperation: { operationId: holder.ready.operationId, reason: "init" } });
    const before = sha256(stateFile(instance));
    // Not INSTANCE_BUSY: the lock is free again, the recorded operation still closes writes.
    expect(await bootRefused(instance)).toEqual(recoveryRequired(["activeOperation"]));
    expect(await bootRefused(instance)).toEqual(recoveryRequired(["activeOperation"]));
    expect(sha256(stateFile(instance))).toBe(before);
    const maintenance = readdirSync(path.join(instance.dir, "control", "maintenance")).sort();
    expect(maintenance).toEqual(["state.json", "writer.lock"]);
  });

  it("a completed operation leaves the next generation and the server starts", async () => {
    const instance = freshTestInstance();
    await bootReady(instance);
    const holder = await startWriterHolder(instance.dir, ["--begin", "--complete"]);
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child, () => "", STOP_TIMEOUT_MS);
    expect(readState(instance)).toEqual({ formatVersion: 1, generation: 1, activeOperation: null });
    expect(await bootReady(instance)).toEqual({ generation: 1, initialized: false });
  });
});

describe("D04.1-AC2 unknown or unreadable gate", () => {
  const valid = { formatVersion: 1, generation: 3, activeOperation: null };
  const cases: ReadonlyArray<readonly [string, unknown, string[]]> = [
    ["unknown format version", { ...valid, formatVersion: 2 }, ["formatVersion"]],
    ["broken JSON", '{"formatVersion":1,', ["state.json"]],
    ["unknown operation variant", { ...valid, activeOperation: { operationId: "0199f3a4-3c1e-7a00-8000-000000000001", reason: "vacuum", phase: "running", startedAt: "2026-10-25T10:00:00.000Z" } }, ["activeOperation"]],
    ["negative generation", { ...valid, generation: -1 }, ["generation"]],
    ["field outside v1", { ...valid, lastWriterPid: 4242 }, ["lastWriterPid"]],
  ];

  it.each(cases)("%s → MAINTENANCE_RECOVERY_REQUIRED without changing the file", async (_name, content, fields) => {
    const instance = freshTestInstance();
    writeGate(instance, content);
    const before = sha256(stateFile(instance));
    expect(await bootRefused(instance)).toEqual(recoveryRequired(fields));
    expect(sha256(stateFile(instance))).toBe(before);
  });

  it.runIf(process.platform !== "win32")("a symlinked gate file is refused, its target untouched", async () => {
    const instance = freshTestInstance();
    const target = path.join(instance.dir, "data", "gate-target.json");
    writeFileSync(target, JSON.stringify(valid));
    symlinkSync(target, stateFile(instance));
    expect(await bootRefused(instance)).toEqual(recoveryRequired(["state.json"]));
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(valid);
  });

  it("a missing gate next to an existing database is not recreated", async () => {
    const instance = freshTestInstance();
    writeFileSync(path.join(instance.dir, "data", "app.db"), "");
    expect(await bootRefused(instance)).toEqual(recoveryRequired(["state.json"]));
    expect(readdirSync(path.join(instance.dir, "control", "maintenance"))).toEqual(["writer.lock"]);
  });

  it("the gate opens and changes only under the held lease", () => {
    const paths = installationWorkingPaths(freshTestInstance().dir);
    const writer = acquireWriterLease(paths.maintenance);
    if (!writer.ok) throw new Error(writer.code);
    const opened = openMaintenanceGate(writer.lease, paths);
    if (!opened.ok) throw new Error(opened.code);
    writer.lease.release();
    expect(() =>
      opened.gate.begin({ operationId: "0199f3a4-3c1e-7a00-8000-000000000002", reason: "init", phase: "initializing", startedAt: "2026-10-25T10:00:00.000Z", targetSchemaVersion: 1 }),
    ).toThrow(/held writer lease/);
    expect(() => openMaintenanceGate(writer.lease, paths)).toThrow(/held writer lease/);
    expect(JSON.parse(readFileSync(path.join(paths.maintenance, "state.json"), "utf8"))).toEqual({ formatVersion: 1, generation: 0, activeOperation: null });
  });
});
