// D56.1 — the command restore-instance ends the operation of an update when the way back asks it to (Architektura §11.2.2, §11.3.3).
// AC1: with the id of the operation `update` that is on the gate, the command restores the database from the copy and, under its lease,
//      closes that operation, so the app that is started after it finds a quiet gate; the generation of the gate is kept.
// AC2: without the id, with another id, with an operation of another kind on the gate, and when the copy cannot be restored, the
//      command changes nothing and the operation stays.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installation, query, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { packages, readState, stateFile, databaseFile, sha256 } from "../../support/database-fixtures.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";

afterEach(stopServers);

const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const run = (script: string, setup: Installation, input?: unknown) => runBuiltScript(path.join(repoRoot, `apps/server/dist/cli/${script}.js`), ["--installation", setup.instance.dir], processEnv(setup), input === undefined ? undefined : JSON.stringify(input));

/** An installation with a copy of itself, stopped, and an operation `update` of the given id on its gate. */
async function withUpdateOnTheGate(over: { reason?: "update" | "import" } = {}) {
  const setup = await installation("a passphrase for the second factor");
  await stopServer(setup.server);
  expect((await run("backup-create", setup)).code).toBe(0);
  const [pkg] = packages(setup.instance);
  const operationId = randomUUID();
  const state = readState(setup.instance);
  const operation = over.reason === "import" ? { operationId, reason: "import", phase: "writing", startedAt: new Date().toISOString() } : { operationId, reason: "update", phase: "verifying", startedAt: new Date().toISOString(), targetRelease: "1.3.0" };
  writeFileSync(stateFile(setup.instance), `${JSON.stringify({ formatVersion: 1, generation: state.generation + 1, activeOperation: operation })}\n`);
  return { setup, name: path.basename(pkg!), operationId, generation: state.generation + 1 };
}

describe("D56.1-AC1 the way back ends the operation it restores for", () => {
  it("restores the copy and closes the operation of that id, keeping the generation, and the app starts on a quiet gate", async () => {
    const { setup, name, operationId, generation } = await withUpdateOnTheGate();
    const exit = await run("restore-instance", setup, { snapshot: name, confirm: "replace-current-database", endsUpdate: operationId });
    expect(exit.code, exit.output).toBe(0);
    expect(outputEvent(exit.output, "instance.restored")).toMatchObject({ snapshot: name });
    expect(outputEvent(exit.output, "instance.update_ended")).toMatchObject({ operationId });
    expect(readState(setup.instance)).toEqual({ formatVersion: 1, generation, activeOperation: null });
    expect(query<{ action: string }>(setup.instance, "SELECT action FROM audit_log WHERE action = 'backup.restored'")).toHaveLength(1);
  });
});

describe("D56.1-AC2 anything else leaves the operation and the database", () => {
  const unchanged = (setup: Installation, before: { state: string; database: string }): void => {
    expect(readFileSync(stateFile(setup.instance), "utf8")).toBe(before.state);
    expect(sha256(databaseFile(setup.instance))).toBe(before.database);
  };

  it("refuses without the id, with another id, and with an operation of another kind, naming the gate and changing nothing", async () => {
    const { setup, name } = await withUpdateOnTheGate();
    const before = { state: readFileSync(stateFile(setup.instance), "utf8"), database: sha256(databaseFile(setup.instance)) };
    for (const input of [{ snapshot: name, confirm: "replace-current-database" }, { snapshot: name, confirm: "replace-current-database", endsUpdate: randomUUID() }]) {
      const exit = await run("restore-instance", setup, input);
      expect(exit.code).toBe(1);
      expect(outputEvent(exit.output, "restore-instance.failed")).toMatchObject({ code: "MAINTENANCE_RECOVERY_REQUIRED", fields: ["activeOperation"] });
      unchanged(setup, before);
    }
    const other = await withUpdateOnTheGate({ reason: "import" });
    const beforeOther = { state: readFileSync(stateFile(other.setup.instance), "utf8"), database: sha256(databaseFile(other.setup.instance)) };
    const exit = await run("restore-instance", other.setup, { snapshot: other.name, confirm: "replace-current-database", endsUpdate: other.operationId });
    expect(outputEvent(exit.output, "restore-instance.failed")).toMatchObject({ code: "MAINTENANCE_RECOVERY_REQUIRED" });
    unchanged(other.setup, beforeOther);
  });

  it("leaves the operation when the copy cannot be restored", async () => {
    const { setup, operationId } = await withUpdateOnTheGate();
    const before = { state: readFileSync(stateFile(setup.instance), "utf8"), database: sha256(databaseFile(setup.instance)) };
    const exit = await run("restore-instance", setup, { snapshot: "20261116T000000Z-pre_update-00000000-0000-4000-8000-000000000000", confirm: "replace-current-database", endsUpdate: operationId });
    expect(exit.code).toBe(1);
    expect(outputEvent(exit.output, "restore-instance.failed")?.["code"]).toBeDefined();
    unchanged(setup, before);
  });
});
