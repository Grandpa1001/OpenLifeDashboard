// D55.1 — the switch of the app by the updater: from `switching` to `verifying` (Architektura §11.2.2 step 5; DEV §9.54), through
// the real server of the updater on HTTP, a real journal, catalog and backup folder, and a recorded stand-in for the app of
// the project (the real containers are in tests/system/updater-docker.ts).
// AC1: once the copy is taken the updater replaces the app by the image of the catalog (never one a command named), has the
//      containers on the journal before the swap and after it, ends in `verifying`, and does it once however often the
//      same command arrives.
// AC2: a failed swap, an app that is not found, a catalog that lost the release and a release that replaces the updater stop
//      the operation in `rolling_back` with a code and nothing replaced; an operation whose swap has begun is not swapped again by asking.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScopeError } from "../../../apps/updater/dist/docker/project-scope.js";
import { openJournal } from "../../../apps/updater/dist/journal/journal.js";
import { catalogFileTextOf } from "../../../apps/updater/dist/release/catalog.js";
import { initialRecord, transition } from "../../../apps/updater/dist/state-machine/transitions.js";
import { APP, catalogOf, closeServers, envelopeOf, fakeSwitchScope, imageOf, install, publishBackup, recordOf, release123, send, start, UPDATER, type Started, type SwitchScope } from "../../support/updater-harness.ts";

afterEach(closeServers);

const FENCE = 6;
const release = { ...release123, version: "1.3.0", schemaVersion: 8 };
const catalog = catalogFileTextOf(catalogOf(release123, release));

/** Waits until the record is in one of the states, the way the app finds it by asking for the status. */
async function reached(server: Started, ...states: string[]): Promise<ReturnType<typeof recordOf>> {
  for (let tries = 0; tries < 300; tries += 1) {
    const record = recordOf(server.dir);
    if (record !== null && states.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the operation did not reach ${states.join(" or ")}: ${JSON.stringify(recordOf(server.dir))}`);
}

/** The commands of the app up to the copy, as D54 sends them; the answer to the last one is what the test looks at. */
async function toBackedUp(server: Started, operationId = randomUUID()) {
  expect((await send(server, install("1.3.0", FENCE, operationId))).status).toBe(202);
  await reached(server, "quiescing");
  expect((await send(server, envelopeOf({ type: "quiesced", fence: FENCE }, operationId))).status).toBe(200);
  const backupId = publishBackup(server.backupDir);
  const answer = await send(server, envelopeOf({ type: "backed_up", backupId, fence: FENCE }, operationId));
  return { operationId, backupId, answer };
}

describe("D55.1-AC1 the updater replaces the app by the release and waits in verifying", () => {
  it("replaces the app by the image of the catalog, has the containers on the journal and ends in verifying", async () => {
    const calls: Array<{ app: { id: string; name: string }; image: string }> = [];
    const server = await start({ catalog, switchScope: fakeSwitchScope(calls) });
    const { operationId } = await toBackedUp(server);
    const record = (await reached(server, "verifying"))!;
    expect(record).toMatchObject({
      state: "verifying",
      operationId,
      targetRelease: "1.3.0",
      replacement: { previousId: "container-a", previousName: "openlife-app-1-previous-1234", nextId: "container-b", name: "openlife-app-1" },
      committed: false,
      error: null,
    });
    // The image is the catalog's, pinned by its digest: nothing in any command named one.
    expect(calls).toEqual([{ app: { id: "container-a", name: "openlife-app-1" }, image: imageOf(APP) }]);
    // The intent was on the journal before the swap: the records go switching, switching with the old container, switching with both, verifying.
    expect(record.seq).toBeGreaterThanOrEqual(8);
    expect(server.engine.requests.every((request) => request.method === "GET" || request.path.startsWith("/images/create"))).toBe(true);
  });

  it("swaps once however often the copy is reported, and answers the repeated report as it was", async () => {
    const calls: Array<{ app: { id: string; name: string }; image: string }> = [];
    const server = await start({ catalog, switchScope: fakeSwitchScope(calls) });
    const { operationId, backupId } = await toBackedUp(server);
    await reached(server, "verifying");
    const before = recordOf(server.dir);
    const again = await send(server, envelopeOf({ type: "backed_up", backupId, fence: FENCE }, operationId));
    // After the swap the operation is in verifying, which a repeated report no longer fits; it is refused and changes nothing.
    expect([again.status, again.json["code"], again.json["state"]]).toEqual([409, "WRONG_STATE", "verifying"]);
    expect(recordOf(server.dir)).toEqual(before);
    expect(calls).toHaveLength(1);
  });

  it("drives an operation that is in switching with nothing replaced when the same operation is asked again, and not one whose swap has begun", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "switch-release-"));
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const base = transition(initialRecord(now), "checking", { operationId, targetRelease: "1.3.0", fence: FENCE }, now);
    const pulling = base.ok ? transition(base.record, "pulling", { targetDigest: APP.digest }, now) : base;
    const quiescing = pulling.ok ? transition(pulling.record, "quiescing", {}, now) : pulling;
    const backing = quiescing.ok ? transition(quiescing.record, "backing_up", {}, now) : quiescing;
    const switching = backing.ok ? transition(backing.record, "switching", { backupId: "20261116T120000Z-pre_update-00000000-0000-4000-8000-000000000000" }, now) : backing;
    if (!switching.ok) throw new Error("not switching");
    openJournal(dir).write(switching.record);
    const calls: Array<{ app: { id: string; name: string }; image: string }> = [];
    const server = await start({ dir, catalog, switchScope: fakeSwitchScope(calls) });
    expect((await send(server, install("1.3.0", FENCE, operationId))).status).toBe(202);
    await reached(server, "verifying");
    expect(calls).toHaveLength(1);

    // A swap that began and was lost (the containers are on the journal, nothing says it ended) is for the recovery, not for asking again.
    const lost = mkdtempSync(path.join(tmpdir(), "switch-release-"));
    openJournal(lost).write({ ...switching.record, seq: switching.record.seq + 1, replacement: { previousId: "container-a", previousName: "openlife-app-1", nextId: null, name: "openlife-app-1" } });
    const other = await start({ dir: lost, catalog, switchScope: fakeSwitchScope(calls) });
    expect((await send(other, install("1.3.0", FENCE, operationId))).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recordOf(lost)).toMatchObject({ state: "switching", replacement: { nextId: null } });
    expect(calls).toHaveLength(1);
  });
});

describe("D55.1-AC2 a failure stops the operation with a code and replaces nothing", () => {
  const failing = (error: unknown, find = true): SwitchScope => ({
    findApp: async () => {
      if (!find) throw error;
      return { id: "container-a", name: "openlife-app-1" };
    },
    replaceApp: async () => {
      throw error;
    },
    discardPrevious: async () => undefined,
  });

  it("stops in rolling_back with SWITCH_FAILED when the swap fails, keeping the old container on the journal and no new one", async () => {
    const server = await start({ catalog, switchScope: failing(new ScopeError("SWITCH_FAILED")) });
    await toBackedUp(server);
    const record = (await reached(server, "rolling_back"))!;
    expect(record).toMatchObject({ state: "rolling_back", error: { code: "SWITCH_FAILED" }, committed: false, replacement: { previousId: "container-a", nextId: null } });
    // The operation holds the instance: another one is refused, and the copy cannot be reported again.
    expect(await send(server, install("1.2.3", FENCE + 1))).toMatchObject({ status: 409, json: { code: "BUSY" } });
    expect(await send(server, envelopeOf({ type: "abort", fence: FENCE }, record.operationId!))).toMatchObject({ status: 409, json: { code: "WRONG_STATE", state: "rolling_back" } });
  });

  it("stops with the code of an app that is not found, and with SWITCH_FAILED for anything that is not a code of the scope", async () => {
    const missing = await start({ catalog, switchScope: failing(new ScopeError("APP_NOT_FOUND"), false) });
    await toBackedUp(missing);
    expect(await reached(missing, "rolling_back")).toMatchObject({ error: { code: "APP_NOT_FOUND" }, replacement: null });
    const strange = await start({ catalog, switchScope: failing(new Error("ECONNRESET /var/run/docker.sock")) });
    await toBackedUp(strange);
    const record = (await reached(strange, "rolling_back"))!;
    expect(record.error).toEqual({ code: "SWITCH_FAILED" });
    // Nothing of the text of the failure is kept.
    expect(JSON.stringify([record, strange.logs])).not.toMatch(/ECONNRESET|docker\.sock/);
  });

  it("stops when the catalog no longer lists the release or now replaces the updater", async () => {
    const calls: Array<{ app: { id: string; name: string }; image: string }> = [];
    const gone = await start({ catalog, switchScope: fakeSwitchScope(calls) });
    // The catalog is changed after the copy and before the swap: the swap reads it again.
    expect((await send(gone, install("1.3.0", FENCE))).status).toBe(202);
    await reached(gone, "quiescing");
    const operationId = recordOf(gone.dir)!.operationId!;
    await send(gone, envelopeOf({ type: "quiesced", fence: FENCE }, operationId));
    writeFileSync(path.join(gone.dir, "release-catalog.json"), catalogFileTextOf(catalogOf(release123, { ...release, updater: UPDATER })));
    const backupId = publishBackup(gone.backupDir);
    await send(gone, envelopeOf({ type: "backed_up", backupId, fence: FENCE }, operationId));
    expect(await reached(gone, "rolling_back")).toMatchObject({ error: { code: "RELEASE_REQUIRES_ADMIN" } });
    expect(calls).toEqual([]);
  });
});
