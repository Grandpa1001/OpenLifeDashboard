// D54.2 — what the app tells the updater between the pull and the switch, through the real server of the updater on HTTP, a real
// journal, a real catalog and backup folder and a fake Engine that records every request (Architektura §11.2.2 steps 2 and 3).
// AC1: `quiesced` and `backed_up` move one operation to `switching` in order and write what a rollback needs (the copy, the
//      pins before, the digest, the versions of the schema); the same command asked again is answered as it was without
//      another record; another operation, an older or a newer fence and a state that cannot take the command are refused with
//      a code and the record stays as it was.
// AC2: `abort` and a copy that is missing, not a `pre_update` one, not whole, a catalog that no longer lists the release and an
//      installation with no way back close the operation as `idle` with a code through `rolling_back` and `rolled_back`, with
//      nothing sent to the Engine beyond the pulls, and the next operation is taken; after the switch an abort is refused.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openJournal } from "../../../apps/updater/dist/journal/journal.js";
import { catalogFileTextOf } from "../../../apps/updater/dist/release/catalog.js";
import { initialRecord, transition } from "../../../apps/updater/dist/state-machine/transitions.js";
import { catalogOf, closeServers, digestOf, envelopeOf, idleSwitchScope, install, publishBackup, recordOf, release123, send, settled, start, type Started } from "../../support/updater-harness.ts";

afterEach(closeServers);

const release8 = { ...release123, version: "1.3.0", schemaVersion: 8 };
const catalog = catalogFileTextOf(catalogOf(release123, release8));
const FENCE = 4;
const asApp = (command: UpdaterEnvelope["command"], operationId: string) => envelopeOf(command, operationId);
const quiesced = (operationId: string, fence = FENCE) => asApp({ type: "quiesced", fence }, operationId);
const backedUp = (operationId: string, backupId: string, fence = FENCE) => asApp({ type: "backed_up", backupId, fence }, operationId);
const abort = (operationId: string, fence = FENCE) => asApp({ type: "abort", fence }, operationId);

/** An operation that has pulled and waits in `quiescing`, as the app finds it by asking for the status. */
async function inQuiescing(options: Parameters<typeof start>[0] = {}): Promise<{ server: Started; operationId: string }> {
  const server = await start({ catalog, switchScope: idleSwitchScope, ...options });
  const operationId = randomUUID();
  expect((await send(server, install("1.3.0", FENCE, operationId))).status).toBe(202);
  expect(await settled(server)).toMatchObject({ state: "quiescing", operationId });
  return { server, operationId };
}
const noContainerTouched = (server: Started): void => expect(server.engine.requests.some((request) => request.path.startsWith("/containers"))).toBe(false);

describe("D54.2-AC1 the order to the switch, the same command twice, and the commands that are refused", () => {
  it("goes quiescing, backing_up, switching and records the copy, the pins before and the versions of the schema", async () => {
    const { server, operationId } = await inQuiescing({ previous: { app: digestOf("app 1.0.0"), updater: digestOf("updater 1.0.0") } });
    const first = await send(server, quiesced(operationId));
    expect([first.status, first.json["state"]]).toEqual([200, "backing_up"]);
    const name = publishBackup(server.backupDir, { schemaVersion: 7 });
    const second = await send(server, backedUp(operationId, name));
    expect([second.status, second.json["state"], second.json["operationId"]]).toEqual([200, "switching", operationId]);
    expect(recordOf(server.dir)).toMatchObject({
      state: "switching",
      backupId: name,
      previousSelection: { app: digestOf("app 1.0.0"), updater: digestOf("updater 1.0.0") },
      previousDigest: digestOf("app 1.0.0"),
      schemaVersionFrom: 7,
      schemaVersionTo: 8,
      committed: false,
      error: null,
    });
    noContainerTouched(server);
  });

  it("answers the same command again as it was and writes no other record", async () => {
    const { server, operationId } = await inQuiescing();
    await send(server, quiesced(operationId));
    const afterQuiesced = recordOf(server.dir)!;
    expect((await send(server, quiesced(operationId))).json["state"]).toBe("backing_up");
    expect(recordOf(server.dir)).toEqual(afterQuiesced);
    const name = publishBackup(server.backupDir);
    await send(server, backedUp(operationId, name));
    const afterBackup = recordOf(server.dir)!;
    expect((await send(server, backedUp(operationId, name))).status).toBe(200);
    expect((await send(server, quiesced(operationId))).json["state"]).toBe("switching");
    expect(recordOf(server.dir)).toEqual(afterBackup);
    // Another copy than the one recorded is not the same command.
    expect(await send(server, backedUp(operationId, publishBackup(server.backupDir)))).toMatchObject({ status: 409, json: { code: "WRONG_STATE", state: "switching" } });
    expect(recordOf(server.dir)).toEqual(afterBackup);
  });

  it("refuses another operation, an older and a newer fence and a state that cannot take the command, and leaves the record", async () => {
    const { server, operationId } = await inQuiescing();
    const before = recordOf(server.dir)!;
    const name = publishBackup(server.backupDir);
    const cases: Array<[string, UpdaterEnvelope, number, string]> = [
      ["another operation", quiesced(randomUUID()), 409, "OPERATION_MISMATCH"],
      ["an older fence", quiesced(operationId, FENCE - 1), 409, "STALE_FENCE"],
      ["a newer fence", quiesced(operationId, FENCE + 1), 409, "FENCE_MISMATCH"],
      ["a copy before the app is quiet", backedUp(operationId, name), 409, "WRONG_STATE"],
      ["a copy of another operation", backedUp(randomUUID(), name), 409, "OPERATION_MISMATCH"],
      ["an abort of another operation", abort(randomUUID()), 409, "OPERATION_MISMATCH"],
      ["an abort with an older fence", abort(operationId, FENCE - 1), 409, "STALE_FENCE"],
    ];
    for (const [name_, envelope, status, code] of cases) {
      const answer = await send(server, envelope);
      expect([answer.status, answer.json["code"]], name_).toEqual([status, code]);
      expect(recordOf(server.dir), name_).toEqual(before);
    }
  });

  it("refuses the commands while the updater is still driving the steps, and before any operation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "install-progress-"));
    const none = await start({ dir });
    expect(await send(none, quiesced(randomUUID()))).toMatchObject({ status: 409, json: { code: "OPERATION_MISMATCH" } });
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const checking = transition(initialRecord(now), "checking", { operationId, targetRelease: "1.3.0", fence: FENCE }, now);
    const pulling = checking.ok ? transition(checking.record, "pulling", {}, now) : checking;
    if (!pulling.ok) throw new Error("not pulling");
    openJournal(dir).write(pulling.record);
    expect(await send(none, quiesced(operationId))).toMatchObject({ status: 409, json: { code: "WRONG_STATE", state: "pulling" } });
    expect(await send(none, abort(operationId))).toMatchObject({ status: 409, json: { code: "WRONG_STATE" } });
    expect(recordOf(dir)).toEqual(pulling.record);
  });
});

describe("D54.2-AC2 an abort and a copy that cannot be trusted close the operation, and A is not touched", () => {
  it("closes an abort in quiescing and in backing_up as idle with ABORTED, through rolling_back and rolled_back, and answers a second abort as done", async () => {
    for (const quiet of [false, true]) {
      const { server, operationId } = await inQuiescing();
      if (quiet) await send(server, quiesced(operationId));
      const startSeq = recordOf(server.dir)!.seq;
      const answer = await send(server, abort(operationId));
      expect([answer.status, answer.json["state"]]).toEqual([200, "idle"]);
      expect(recordOf(server.dir)).toMatchObject({ state: "idle", operationId, error: { code: "ABORTED" }, committed: false, seq: startSeq + 3 });
      expect(openJournal(server.dir).read()).toMatchObject({ ok: true });
      const again = await send(server, abort(operationId));
      expect([again.status, again.json["state"]]).toEqual([200, "idle"]);
      expect(recordOf(server.dir)!.seq).toBe(startSeq + 3);
      noContainerTouched(server);
      // The instance is free: the next operation is taken, with a clean record.
      expect((await send(server, install("1.2.3", FENCE + 1))).status).toBe(202);
      expect(await settled(server)).toMatchObject({ state: "quiescing", fence: FENCE + 1, error: null, backupId: null });
    }
  });

  it("refuses an abort after the switch has begun and keeps the operation", async () => {
    const { server, operationId } = await inQuiescing();
    await send(server, quiesced(operationId));
    await send(server, backedUp(operationId, publishBackup(server.backupDir)));
    const before = recordOf(server.dir)!;
    expect(await send(server, abort(operationId))).toMatchObject({ status: 409, json: { code: "WRONG_STATE", state: "switching" } });
    expect(recordOf(server.dir)).toEqual(before);
  });

  it("closes a copy that is missing, of another reason, not whole, a link or named as no package, and takes the next operation", async () => {
    const cases: Array<[string, (backupDir: string) => string, string]> = [
      ["missing", () => `20261116T120000Z-pre_update-${randomUUID()}`, "BACKUP_MISSING"],
      ["of another reason", (dir) => publishBackup(dir, { reason: "nightly" }), "BACKUP_INVALID"],
      ["with a file that is not part of a package", (dir) => publishBackup(dir, { extraFile: "app.db-wal" }), "BACKUP_INVALID"],
      ["named as a path", () => "../../etc/passwd", "REFUSED_BEFORE"],
    ];
    for (const [name, make, code] of cases) {
      const { server, operationId } = await inQuiescing();
      await send(server, quiesced(operationId));
      const backupId = make(server.backupDir);
      const answer = await send(server, backedUp(operationId, backupId));
      if (code === "REFUSED_BEFORE") {
        // A name that is not the name of a package is not a command at all; the operation waits for a proper one.
        expect(answer.status, name).toBe(400);
        expect(recordOf(server.dir), name).toMatchObject({ state: "backing_up" });
        continue;
      }
      expect([answer.status, answer.json["code"], answer.json["state"]], name).toEqual([409, code, "idle"]);
      expect(recordOf(server.dir), name).toMatchObject({ state: "idle", backupId: null, previousSelection: null, error: { code } });
      noContainerTouched(server);
      expect((await send(server, install("1.2.3", FENCE + 1))).status, name).toBe(202);
    }
  });

  it("closes a copy whose meta changed after its checksum, and a copy that is a link", async () => {
    const changed = await inQuiescing();
    await send(changed.server, quiesced(changed.operationId));
    const name = publishBackup(changed.server.backupDir);
    const metaFile = path.join(changed.server.backupDir, name, "meta.json");
    writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(readFileSync(metaFile, "utf8")), appVersion: "9.9.9" }));
    expect(await send(changed.server, backedUp(changed.operationId, name))).toMatchObject({ status: 409, json: { code: "BACKUP_INVALID", state: "idle" } });

    const linked = await inQuiescing();
    await send(linked.server, quiesced(linked.operationId));
    // A good package elsewhere, reached through a link under the name of a package of the folder.
    const elsewhere = mkdtempSync(path.join(tmpdir(), "install-progress-elsewhere-"));
    const real = publishBackup(elsewhere);
    symlinkSync(path.join(elsewhere, real), path.join(linked.server.backupDir, real));
    expect(await send(linked.server, backedUp(linked.operationId, real))).toMatchObject({ status: 409, json: { code: "BACKUP_INVALID", state: "idle" } });
  });

  it("closes the operation when the catalog no longer lists the release or the installation has no way back", async () => {
    const gone = await inQuiescing();
    await send(gone.server, quiesced(gone.operationId));
    writeFileSync(path.join(gone.server.dir, "release-catalog.json"), catalogFileTextOf(catalogOf(release123)));
    expect(await send(gone.server, backedUp(gone.operationId, publishBackup(gone.server.backupDir)))).toMatchObject({ status: 409, json: { code: "RELEASE_UNKNOWN", state: "idle" } });

    const lost = await inQuiescing({ previous: null });
    await send(lost.server, quiesced(lost.operationId));
    expect(await send(lost.server, backedUp(lost.operationId, publishBackup(lost.server.backupDir)))).toMatchObject({ status: 409, json: { code: "PREVIOUS_UNKNOWN", state: "idle" } });
    expect(recordOf(lost.server.dir)).toMatchObject({ state: "idle", previousSelection: null, error: { code: "PREVIOUS_UNKNOWN" } });
    noContainerTouched(lost.server);
  });

  it("holds no path, token or text of a file in the log of a refusal", async () => {
    const { server, operationId } = await inQuiescing();
    await send(server, quiesced(operationId));
    await send(server, backedUp(operationId, `20261116T120000Z-pre_update-${randomUUID()}`));
    const text = JSON.stringify(server.logs);
    expect(text).not.toContain(server.backupDir);
    expect(text).toContain("BACKUP_MISSING");
  });
});
