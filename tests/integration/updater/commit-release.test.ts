// D55.3 — the proof of the new app and the commit point of the updater (Architektura §11.2.2 step 7; DEV §9.54), through the real server
// of the updater on HTTP, a real journal, catalog, backup folder and release file, and a recorded stand-in for the app of the project.
// AC1: the `ready` of the new app that fits the release of the catalog (version of the application and of the schema) takes the
//      operation through `committing` to `completed`: the choice of the release is in the file, read back and the same, the commit point
//      is on the journal before the end, the replaced app is discarded, the updater of the installation is kept, and the same proof asked
//      again is answered as it was.
// AC2: a proof that does not fit, none in time, a proof in a state that cannot take it, a file that cannot be written and a release the
//      catalog lost commit nothing: the operation stops in `rolling_back` with a code, no file is written, nothing is discarded, and
//      a proof after that is refused; a replaced app that cannot be discarded does not undo the commit.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { catalogFileTextOf } from "../../../apps/updater/dist/release/catalog.js";
import { RELEASE_FILE_NAME, readReleaseFile, renderReleaseFile } from "../../../apps/updater/dist/release/release-file.js";
import { APP, catalogOf, closeServers, digestOf, envelopeOf, fakeSwitchScope, install, publishBackup, recordOf, release123, send, start, UPDATER, type Started } from "../../support/updater-harness.ts";

afterEach(closeServers);

const FENCE = 6;
const release = { ...release123, version: "1.3.0", schemaVersion: 8 };
const catalog = catalogFileTextOf(catalogOf(release123, release));
type Discard = { previousId: string; previousName: string; nextId: string; name: string };
const fileOf = (server: Started): string => readFileSync(path.join(server.dir, RELEASE_FILE_NAME), "utf8");

async function reached(server: Started, ...states: string[]): Promise<NonNullable<ReturnType<typeof recordOf>>> {
  for (let tries = 0; tries < 300; tries += 1) {
    const record = recordOf(server.dir);
    if (record !== null && states.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the operation did not reach ${states.join(" or ")}: ${JSON.stringify(recordOf(server.dir))}`);
}

/** The commands of the app up to the swap: the operation waits in `verifying` for the new app. */
async function toVerifying(server: Started) {
  const operationId = randomUUID();
  expect((await send(server, install("1.3.0", FENCE, operationId))).status).toBe(202);
  await reached(server, "quiescing");
  await send(server, envelopeOf({ type: "quiesced", fence: FENCE }, operationId));
  await send(server, envelopeOf({ type: "backed_up", backupId: publishBackup(server.backupDir), fence: FENCE }, operationId));
  await reached(server, "verifying");
  return operationId;
}
const ready = (operationId: string, over: { appVersion?: string; schemaVersion?: number; fence?: number } = {}) =>
  envelopeOf({ type: "ready", fence: over.fence ?? FENCE, appVersion: over.appVersion ?? "1.3.0", schemaVersion: over.schemaVersion ?? 8 }, operationId);

describe("D55.3-AC1 a proof that fits the release commits the choice and completes the operation", () => {
  it("writes the choice of the release, writes the commit point before the end, discards the replaced app and answers the status", async () => {
    const discards: Discard[] = [];
    const server = await start({ catalog, switchScope: fakeSwitchScope([], discards) });
    const operationId = await toVerifying(server);
    const seqBefore = recordOf(server.dir)!.seq;
    const answer = await send(server, ready(operationId));
    expect([answer.status, answer.json["state"], answer.json["committed"]]).toEqual([200, "completed", true]);
    const record = recordOf(server.dir)!;
    // committing, the commit point, completed: three records, the commit point being the one that carries `committed`.
    expect(record).toMatchObject({ state: "completed", committed: true, operationId, error: null, seq: seqBefore + 3 });
    const expected = renderReleaseFile({ app: APP, updater: null });
    if (!expected.ok) throw new Error("not rendered");
    expect(fileOf(server)).toBe(expected.text);
    expect(discards).toEqual([{ previousId: "container-a", previousName: "openlife-app-1-previous-1234", nextId: "container-b", name: "openlife-app-1" }]);
    // Nothing more is written to the file by the same proof asked again, and nothing more is discarded.
    const again = await send(server, ready(operationId));
    expect([again.status, again.json["state"]]).toEqual([200, "completed"]);
    expect(recordOf(server.dir)).toEqual(record);
    expect(discards).toHaveLength(1);
    // The instance is free: the next operation is taken.
    expect((await send(server, install("1.2.3", FENCE + 1))).status).toBe(202);
  });

  it("keeps the updater the installation already has and replaces only the app", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "commit-release-"));
    const before = renderReleaseFile({ app: { repository: APP.repository, digest: digestOf("app 1.0.0") }, updater: UPDATER });
    if (!before.ok) throw new Error("not rendered");
    writeFileSync(path.join(dir, RELEASE_FILE_NAME), before.text);
    const server = await start({ dir, catalog, switchScope: fakeSwitchScope() });
    const operationId = await toVerifying(server);
    expect((await send(server, ready(operationId))).status).toBe(200);
    const after = readReleaseFile(fileOf(server));
    expect(after.ok && after.selection).toEqual({ app: APP, updater: UPDATER });
  });
});

describe("D55.3-AC2 a proof that does not fit commits nothing", () => {
  const notCommitted = (server: Started, discards: Discard[]): void => {
    expect(() => fileOf(server)).toThrow();
    expect(discards).toEqual([]);
    expect(recordOf(server.dir)).toMatchObject({ committed: false });
  };

  it("stops in rolling_back for another version or another schema than the release, with no file and nothing discarded", async () => {
    for (const [name, over, code] of [
      ["another version", { appVersion: "1.2.3" }, "VERSION_MISMATCH"],
      ["another schema", { schemaVersion: 9 }, "SCHEMA_MISMATCH"],
    ] as const) {
      const discards: Discard[] = [];
      const server = await start({ catalog, switchScope: fakeSwitchScope([], discards) });
      const operationId = await toVerifying(server);
      const answer = await send(server, ready(operationId, over));
      expect([answer.status, answer.json["code"], answer.json["state"]], name).toEqual([409, code, "rolling_back"]);
      expect(recordOf(server.dir), name).toMatchObject({ state: "rolling_back", error: { code } });
      notCommitted(server, discards);
      // The operation is stopped: the proof asked again, even a good one, is refused.
      expect((await send(server, ready(operationId))).json["code"], name).toBe("WRONG_STATE");
    }
  });

  it("refuses a proof of another operation, another fence or a state that cannot take it, and leaves the record", async () => {
    const server = await start({ catalog, switchScope: fakeSwitchScope() });
    expect((await send(server, ready(randomUUID()))).json["code"]).toBe("OPERATION_MISMATCH");
    const operationId = await toVerifying(server);
    const before = recordOf(server.dir);
    expect((await send(server, ready(randomUUID()))).json["code"]).toBe("OPERATION_MISMATCH");
    expect((await send(server, ready(operationId, { fence: FENCE - 1 }))).json["code"]).toBe("STALE_FENCE");
    expect((await send(server, ready(operationId, { fence: FENCE + 1 }))).json["code"]).toBe("FENCE_MISMATCH");
    expect(recordOf(server.dir)).toEqual(before);
    // Before the switch the new app does not exist: a proof in `quiescing` is refused.
    const early = await start({ catalog, switchScope: fakeSwitchScope() });
    const earlyId = randomUUID();
    await send(early, install("1.3.0", FENCE, earlyId));
    await reached(early, "quiescing");
    expect(await send(early, ready(earlyId))).toMatchObject({ status: 409, json: { code: "WRONG_STATE", state: "quiescing" } });
  });

  it("stops in rolling_back with START_TIMEOUT when no proof comes in time, and refuses a proof after it", async () => {
    const discards: Discard[] = [];
    const server = await start({ catalog, switchScope: fakeSwitchScope([], discards), startTimeoutMs: 40 });
    const operationId = await toVerifying(server);
    expect(await reached(server, "rolling_back")).toMatchObject({ error: { code: "START_TIMEOUT" }, committed: false });
    expect(await send(server, ready(operationId))).toMatchObject({ status: 409, json: { code: "WRONG_STATE", state: "rolling_back" } });
    notCommitted(server, discards);
  });

  it("does not let the timer stop an operation that has been committed", async () => {
    const server = await start({ catalog, switchScope: fakeSwitchScope(), startTimeoutMs: 80 });
    const operationId = await toVerifying(server);
    expect((await send(server, ready(operationId))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(recordOf(server.dir)).toMatchObject({ state: "completed", committed: true });
  });

  it("stops in rolling_back when the file cannot be written, with the commit point not written", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "commit-release-"));
    // A directory where the file belongs: the rename cannot put the choice there.
    mkdirSync(path.join(dir, RELEASE_FILE_NAME), { recursive: true });
    const discards: Discard[] = [];
    const server = await start({ dir, catalog, switchScope: fakeSwitchScope([], discards) });
    const operationId = await toVerifying(server);
    const answer = await send(server, ready(operationId));
    expect([answer.status, answer.json["code"], answer.json["state"]]).toEqual([409, "RELEASE_FILE_FAILED", "rolling_back"]);
    expect(recordOf(server.dir)).toMatchObject({ state: "rolling_back", committed: false, error: { code: "RELEASE_FILE_FAILED" } });
    expect(discards).toEqual([]);
  });

  it("stops when the catalog no longer lists the release, and keeps the commit when the replaced app cannot be discarded", async () => {
    const gone = await start({ catalog, switchScope: fakeSwitchScope() });
    const goneId = await toVerifying(gone);
    writeFileSync(path.join(gone.dir, "release-catalog.json"), catalogFileTextOf(catalogOf(release123)));
    expect(await send(gone, ready(goneId))).toMatchObject({ status: 409, json: { code: "RELEASE_UNKNOWN", state: "rolling_back" } });

    const failing = { ...fakeSwitchScope(), discardPrevious: async () => { throw new Error("the Engine said no: /var/run/docker.sock"); } };
    const kept = await start({ catalog, switchScope: failing });
    const keptId = await toVerifying(kept);
    const answer = await send(kept, ready(keptId));
    expect([answer.status, answer.json["state"], answer.json["committed"]]).toEqual([200, "completed", true]);
    expect(recordOf(kept.dir)).toMatchObject({ state: "completed", committed: true });
    expect(fileOf(kept)).toContain(APP.digest);
    expect(JSON.stringify(kept.logs)).not.toContain("docker.sock");
  });
});
