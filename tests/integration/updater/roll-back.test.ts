// D56.1 — the way back to the app A after a failure past the switch (Architektura §11.2.2 "Awaria przed commit point"; DEV §9.55), through
// the real server of the updater on HTTP with a real journal, catalog, backup folder and release file, and a recorded stand-in for the Docker
// scope (the real containers, the helper and the database are in tests/system/update-rollback.ts).
// AC1: a proof that does not fit, no proof in time and a swap that failed each end in the same way: the apps of the project are stopped, the
//      new one removed, the helper restores the copy of the operation and ends the operation on the gate, the release file is as it was
//      before the operation (or absent), the old app is started and healthy, and only then is the operation `rolled_back` and `idle`
//      with the code that stopped it.
// AC2: a step that fails ends in `recovery_failed` with the code of the step and the later steps are not made: no start of the app, the
//      file as it was left, the instance held, a new operation and any proof refused, and nothing opens.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScopeError } from "../../../apps/updater/dist/docker/project-scope.js";
import { catalogFileTextOf } from "../../../apps/updater/dist/release/catalog.js";
import { RELEASE_FILE_NAME, renderReleaseFile } from "../../../apps/updater/dist/release/release-file.js";
import { APP, catalogOf, closeServers, digestOf, envelopeOf, fakeRollbackScope, fakeSwitchScope, install, publishBackup, recordOf, release123, send, start, type Started, type SwitchScope } from "../../support/updater-harness.ts";

afterEach(closeServers);

const FENCE = 6;
const release = { ...release123, version: "1.3.0", schemaVersion: 8 };
const catalog = catalogFileTextOf(catalogOf(release123, release));
const OLD_PIN = { repository: APP.repository, digest: digestOf("app 1.0.0") };

async function reached(server: Started, ...states: string[]): Promise<NonNullable<ReturnType<typeof recordOf>>> {
  for (let tries = 0; tries < 400; tries += 1) {
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
const ready = (operationId: string, over: { appVersion?: string; schemaVersion?: number } = {}) => envelopeOf({ type: "ready", fence: FENCE, appVersion: over.appVersion ?? "1.3.0", schemaVersion: over.schemaVersion ?? 8 }, operationId);
const releaseFile = (dir: string): string | null => (existsSync(path.join(dir, RELEASE_FILE_NAME)) ? readFileSync(path.join(dir, RELEASE_FILE_NAME), "utf8") : null);
/** A folder that already holds a release file, as an installation that was updated before. */
function withFile(): { dir: string; text: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "roll-back-"));
  const rendered = renderReleaseFile({ app: OLD_PIN, updater: null });
  if (!rendered.ok) throw new Error("not rendered");
  writeFileSync(path.join(dir, RELEASE_FILE_NAME), rendered.text);
  return { dir, text: rendered.text };
}

describe("D56.1-AC1 every failure past the switch ends in the old app on its copy", () => {
  const order = (calls: string[], backupId: string, operationId: string): void => {
    expect(calls).toEqual([
      "retireReplacement container-a container-b",
      "retireOthers container-a",
      "isRunning container-a",
      "stopApp container-a",
      "imageOfApp container-a",
      `runRecovery container-a ${backupId} ${operationId}`,
      "startApp container-a",
      "waitHealthy container-a",
    ]);
  };

  it("for a proof of another version: the same steps in the same order, the file as it was, rolled_back and then idle with the code", async () => {
    const calls: string[] = [];
    const { dir, text } = withFile();
    const server = await start({ dir, catalog, switchScope: fakeSwitchScope(), rollbackScope: fakeRollbackScope(calls) });
    const operationId = await toVerifying(server);
    const backupId = recordOf(server.dir)!.backupId!;
    expect((await send(server, ready(operationId, { appVersion: "1.2.3" }))).json["code"]).toBe("VERSION_MISMATCH");
    const record = await reached(server, "idle");
    order(calls, backupId, operationId);
    expect(record).toMatchObject({ state: "idle", error: { code: "VERSION_MISMATCH" }, committed: false, operationId });
    expect(releaseFile(server.dir)).toBe(text);
    // The instance is free again.
    expect((await send(server, install("1.2.3", FENCE + 1))).status).toBe(202);
  });

  it("puts the file back as it was when the operation had changed it, and removes it when there was none", async () => {
    const calls: string[] = [];
    const { dir, text } = withFile();
    const changed = await start({ dir, catalog, switchScope: fakeSwitchScope(), rollbackScope: fakeRollbackScope(calls) });
    const operationId = await toVerifying(changed);
    const other = renderReleaseFile({ app: { repository: APP.repository, digest: digestOf("another") }, updater: null });
    if (!other.ok) throw new Error("not rendered");
    writeFileSync(path.join(dir, RELEASE_FILE_NAME), other.text);
    await send(changed, ready(operationId, { schemaVersion: 9 }));
    await reached(changed, "idle");
    expect(releaseFile(changed.dir)).toBe(text);

    const none = await start({ catalog, switchScope: fakeSwitchScope(), rollbackScope: fakeRollbackScope() });
    const noneId = await toVerifying(none);
    writeFileSync(path.join(none.dir, RELEASE_FILE_NAME), other.text);
    await send(none, ready(noneId, { schemaVersion: 9 }));
    await reached(none, "idle");
    expect(releaseFile(none.dir)).toBeNull();
  });

  it("when no proof comes in time", async () => {
    const calls: string[] = [];
    const server = await start({ catalog, switchScope: fakeSwitchScope(), rollbackScope: fakeRollbackScope(calls), startTimeoutMs: 40 });
    const operationId = await toVerifying(server);
    const record = await reached(server, "idle");
    expect(record).toMatchObject({ error: { code: "START_TIMEOUT" } });
    order(calls, record.backupId!, operationId);
  });

  it("when the swap failed: the new app is not there, and the old one is still put right", async () => {
    const calls: string[] = [];
    const failing: SwitchScope = { ...fakeSwitchScope(), replaceApp: async () => { throw new ScopeError("SWITCH_FAILED"); } };
    const server = await start({ catalog, switchScope: failing, rollbackScope: fakeRollbackScope(calls) });
    const operationId = randomUUID();
    await send(server, install("1.3.0", FENCE, operationId));
    await reached(server, "quiescing");
    await send(server, envelopeOf({ type: "quiesced", fence: FENCE }, operationId));
    await send(server, envelopeOf({ type: "backed_up", backupId: publishBackup(server.backupDir), fence: FENCE }, operationId));
    const record = await reached(server, "idle");
    expect(record).toMatchObject({ error: { code: "SWITCH_FAILED" }, replacement: { previousId: "container-a", nextId: null } });
    expect(calls.slice(0, 2)).toEqual(["retireReplacement container-a -", "retireOthers container-a"]);
    expect(calls).toContain(`runRecovery container-a ${record.backupId} ${operationId}`);
  });
});

describe("D56.1-AC2 a step that fails stops the way back at recovery_failed and opens nothing", () => {
  const failAt = async (fail: Parameters<typeof fakeRollbackScope>[1], exitCode = 0) => {
    const calls: string[] = [];
    const { dir, text } = withFile();
    const server = await start({ dir, catalog, switchScope: fakeSwitchScope(), rollbackScope: fakeRollbackScope(calls, fail, exitCode) });
    const operationId = await toVerifying(server);
    await send(server, ready(operationId, { appVersion: "1.2.3" }));
    const record = await reached(server, "idle", "recovery_failed");
    return { server, calls, record, operationId, text };
  };

  it("when the apps cannot be stopped and the new one removed: no helper, no start", async () => {
    const { calls, record, server, text } = await failAt({ retireReplacement: new ScopeError("OUT_OF_SCOPE") });
    expect(record).toMatchObject({ state: "recovery_failed", error: { code: "OUT_OF_SCOPE" } });
    expect(calls.some((call) => call.startsWith("runRecovery") || call.startsWith("startApp"))).toBe(false);
    expect(releaseFile(server.dir)).toBe(text);
  });

  it("when the helper fails or exits with a code: the file is not touched and the app is not started", async () => {
    for (const result of [await failAt({}, 1), await failAt({ runRecovery: new Error("the helper could not run: /var/run/docker.sock") })]) {
      expect(result.record).toMatchObject({ state: "recovery_failed", error: { code: "RESTORE_FAILED" } });
      expect(result.calls.some((call) => call.startsWith("startApp"))).toBe(false);
      expect(releaseFile(result.server.dir)).toBe(result.text);
      expect(JSON.stringify(result.server.logs)).not.toContain("docker.sock");
    }
  });

  it("when the old app does not come up healthy: nothing is written as made and the instance is held", async () => {
    const { server, record, operationId } = await failAt({ waitHealthy: new ScopeError("UNHEALTHY") });
    expect(record).toMatchObject({ state: "recovery_failed", error: { code: "UNHEALTHY" } });
    // A new operation is refused, a proof is refused, and only the operator closes it.
    expect(await send(server, install("1.2.3", FENCE + 1))).toMatchObject({ status: 409, json: { code: "BUSY" } });
    expect((await send(server, ready(operationId))).json["code"]).toBe("WRONG_STATE");
    expect(recordOf(server.dir)).toMatchObject({ state: "recovery_failed" });
  });
});
