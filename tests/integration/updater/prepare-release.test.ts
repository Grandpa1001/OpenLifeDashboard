// D54.1 — the catalog of releases and the first steps of an installation, through the real server of the updater on HTTP,
// a real journal, a real catalog file and a fake Engine that records every request (Architektura §11.2.1, §11.2.2; DEV §9.53).
// AC1: a version the catalog does not list, a catalog that is missing, too large, a link, not whole, not of the shape or
//      with a repository that is none are refused with a code, the operation ends `idle`, and nothing at all is sent to
//      the Engine, so the app A is untouched.
// AC2: the images are pulled by the digests of the catalog and nothing else: a pull that fails (the Engine's answer or a
//      line of the stream) and an image that is not the pinned digest end `idle` with a code, a good pull ends in
//      `quiescing` with the digest on the record, and the same operation asked again after a restart is driven from where
//      the journal says it was, without a second drive while it is going on.
import { randomUUID } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_SIGNATURE_HEADER, type UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { RELEASE_CATALOG_FILE, RELEASE_CATALOG_MAX_BYTES } from "@openlife/contracts/updates/catalog";
import { afterEach, describe, expect, it } from "vitest";
import { openJournal } from "../../../apps/updater/dist/journal/journal.js";
import { signCommand } from "../../../apps/updater/dist/protocol/verify-command.js";
import { catalogFileTextOf } from "../../../apps/updater/dist/release/catalog.js";
import { initialRecord, transition } from "../../../apps/updater/dist/state-machine/transitions.js";
import { APP, catalogOf, closeServers, digestOf, fakeEngine, imageOf, install, recordOf, release123, send, settled, start, TOKEN, UPDATER } from "../../support/updater-harness.ts";

afterEach(closeServers);


describe("D54.1-AC1 a version the catalog does not vouch for is refused before anything is sent to the Engine", () => {
  it("refuses a version that is not in the catalog, with the release it asked for on the record and nothing sent", async () => {
    const server = await start({ catalog: catalogFileTextOf(catalogOf(release123)) });
    const answer = await send(server, install("9.9.9"));
    expect(answer.status).toBe(202);
    const record = await settled(server);
    expect(record).toMatchObject({ state: "idle", targetRelease: "9.9.9", targetDigest: null, error: { code: "RELEASE_UNKNOWN" } });
    expect(server.engine.requests).toEqual([]);
  });

  it("refuses a missing catalog, one that is too large, one that is a link and every one that is not whole or not of the shape", async () => {
    const base = catalogOf(release123);
    const text = catalogFileTextOf(base);
    const parsed = JSON.parse(text) as { catalog: Record<string, unknown>; sha256: string };
    const cases: Array<[string, string | null, string]> = [
      ["missing", null, "CATALOG_MISSING"],
      ["too large", `${text}${" ".repeat(RELEASE_CATALOG_MAX_BYTES)}`, "CATALOG_TOO_LARGE"],
      ["not JSON", "this is not a catalog", "CATALOG_INVALID"],
      ["changed after the hash was made", text.replace('"schemaVersion":7', '"schemaVersion":8'), "CATALOG_INVALID"],
      ["a hash that is not one", JSON.stringify({ catalog: parsed.catalog, sha256: "0".repeat(64) }), "CATALOG_INVALID"],
      ["another key", JSON.stringify({ ...parsed, extra: true }), "CATALOG_INVALID"],
      ["a digest that is not a digest", catalogFileTextOf(catalogOf({ ...release123, app: { ...APP, digest: "sha256:short" } })), "CATALOG_INVALID"],
      ["a repository with a tag", catalogFileTextOf(catalogOf({ ...release123, app: { ...APP, repository: "registry.example.com/openlife/app:latest" } })), "CATALOG_INVALID"],
      ["a repository with a scheme", catalogFileTextOf(catalogOf({ ...release123, app: { ...APP, repository: "https://registry.example.com/app" } })), "CATALOG_INVALID"],
      ["a version listed twice", catalogFileTextOf(catalogOf(release123, { ...release123, schemaVersion: 8 })), "CATALOG_INVALID"],
      ["a version that is not one", catalogFileTextOf(catalogOf({ ...release123, version: "latest" })), "CATALOG_INVALID"],
    ];
    for (const [name, catalog, code] of cases) {
      const server = await start({ catalog });
      expect((await send(server, install("1.2.3"))).status, name).toBe(202);
      expect(await settled(server), name).toMatchObject({ state: "idle", error: { code } });
      expect(server.engine.requests, name).toEqual([]);
    }
    // A link to a good catalog is not a catalog: the file must be the regular file of the folder.
    const dir = mkdtempSync(path.join(tmpdir(), "prepare-release-"));
    const elsewhere = path.join(mkdtempSync(path.join(tmpdir(), "prepare-release-elsewhere-")), "catalog.json");
    writeFileSync(elsewhere, text);
    symlinkSync(elsewhere, path.join(dir, RELEASE_CATALOG_FILE));
    const linked = await start({ dir });
    await send(linked, install("1.2.3"));
    expect(await settled(linked)).toMatchObject({ state: "idle", error: { code: "CATALOG_INVALID" } });
    expect(linked.engine.requests).toEqual([]);
  });

  it("never lets the command name an image: only a version of the catalog is pulled, whatever else the envelope carries", async () => {
    const server = await start({ catalog: catalogFileTextOf(catalogOf(release123)) });
    const body = JSON.stringify({ ...install("1.2.3"), command: { type: "install", release: "1.2.3", fence: 1, image: "evil.example/app@sha256:" + "a".repeat(64) } });
    const envelope = JSON.parse(body) as UpdaterEnvelope;
    const signature = signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body });
    const reply = await fetch(`${server.url}${UPDATER_COMMAND_PATH}`, { method: "POST", headers: { [UPDATER_SIGNATURE_HEADER]: signature }, body });
    expect(reply.status).toBe(400);
    expect(server.engine.requests).toEqual([]);
    expect(recordOf(server.dir)).toBeNull();
  });
});

describe("D54.1-AC2 the image is pulled by the digest of the catalog and proved, or the operation ends idle with a code", () => {
  it("pulls the app of the release by its digest and ends in quiescing with the digest on the record", async () => {
    const server = await start({ catalog: catalogFileTextOf(catalogOf(release123, { ...release123, version: "1.3.0", minFrom: "1.2.0", schemaVersion: 8 })) });
    const operationId = randomUUID();
    expect((await send(server, install("1.3.0", 4, operationId))).status).toBe(202);
    const record = await settled(server);
    expect(record).toMatchObject({ state: "quiescing", operationId, fence: 4, targetRelease: "1.3.0", targetDigest: APP.digest, committed: false, error: null });
    const pulls = server.engine.requests.filter((request) => request.method === "POST").map((request) => decodeURIComponent(request.path.split("fromImage=")[1] ?? ""));
    expect(pulls).toEqual([imageOf(APP)]);
    // Only pulls and the look at the pulled images: nothing is created, started, stopped, renamed or deleted, so the app A is as it was.
    expect(server.engine.requests.every((request) => request.method === "GET" || request.path.startsWith("/images/create?fromImage="))).toBe(true);
    expect(server.engine.requests.some((request) => request.path.startsWith("/containers"))).toBe(false);
  });

  it("refuses a release that replaces the updater, which is for the administrator, before anything is pulled", async () => {
    const server = await start({ catalog: catalogFileTextOf(catalogOf(release123, { ...release123, version: "1.3.0", updater: UPDATER, schemaVersion: 8 })) });
    expect((await send(server, install("1.3.0"))).status).toBe(202);
    expect(await settled(server)).toMatchObject({ state: "idle", targetRelease: "1.3.0", error: { code: "RELEASE_REQUIRES_ADMIN" } });
    expect(server.engine.requests).toEqual([]);
  });

  it("ends idle with PULL_FAILED when the Engine refuses the pull or the stream of the pull carries an error", async () => {
    for (const answer of [{ status: 404, body: Buffer.from('{"message":"manifest unknown"}') }, { status: 200, body: Buffer.from('{"status":"Pulling"}\n{"error":"unauthorized: no access"}\n') }]) {
      const engine = fakeEngine();
      engine.pullAnswer = () => answer;
      const server = await start({ catalog: catalogFileTextOf(catalogOf(release123)), engine });
      await send(server, install("1.2.3"));
      const record = await settled(server);
      expect(record).toMatchObject({ state: "idle", targetRelease: "1.2.3", error: { code: "PULL_FAILED" } });
      expect(server.engine.requests.some((request) => request.path.startsWith("/containers"))).toBe(false);
      // The text of the Engine is not kept: neither the journal nor the log holds it.
      expect(JSON.stringify([record, server.logs])).not.toMatch(/manifest unknown|unauthorized|no access/);
    }
  });

  it("ends idle with DIGEST_MISMATCH when the image that is now there is not the pinned digest", async () => {
    const engine = fakeEngine();
    engine.digestsOf = () => [`${APP.repository}@${digestOf("another image")}`];
    const server = await start({ catalog: catalogFileTextOf(catalogOf(release123)), engine });
    await send(server, install("1.2.3"));
    expect(await settled(server)).toMatchObject({ state: "idle", error: { code: "DIGEST_MISMATCH" } });
    // An image with no digests at all (a local build under the name) is no proof either.
    const bare = fakeEngine();
    bare.digestsOf = () => [];
    const second = await start({ catalog: catalogFileTextOf(catalogOf(release123)), engine: bare });
    await send(second, install("1.2.3"));
    expect(await settled(second)).toMatchObject({ state: "idle", error: { code: "DIGEST_MISMATCH" } });
  });

  it("closes the operation of a failed pull, so the next one is taken with a clean record", async () => {
    const engine = fakeEngine();
    engine.pullAnswer = () => ({ status: 500, body: Buffer.from("{}") });
    const server = await start({ catalog: catalogFileTextOf(catalogOf(release123)), engine });
    await send(server, install("1.2.3", 2));
    await settled(server);
    engine.pullAnswer = () => ({ status: 200, body: Buffer.from('{"status":"ok"}\n') });
    expect((await send(server, install("1.2.3", 3))).status).toBe(202);
    expect(await settled(server)).toMatchObject({ state: "quiescing", fence: 3, error: null });
  });

  it("drives the same operation from where the journal says it was after a restart, once, and refuses another while it is held", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prepare-release-"));
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const checking = transition(initialRecord(now), "checking", { operationId, targetRelease: "1.2.3", fence: 3 }, now);
    if (!checking.ok) throw new Error("not begun");
    const pulling = transition(checking.record, "pulling", { targetDigest: APP.digest }, now);
    if (!pulling.ok) throw new Error("not pulling");
    openJournal(dir).write(pulling.record);
    const server = await start({ dir, catalog: catalogFileTextOf(catalogOf(release123)) });
    // Asked twice at once: the process drives the operation once.
    const [first, second] = await Promise.all([send(server, install("1.2.3", 3, operationId)), send(server, install("1.2.3", 3, operationId))]);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(await settled(server)).toMatchObject({ state: "quiescing", operationId, targetDigest: APP.digest });
    expect(server.engine.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(await send(server, install("1.2.3", 3))).toMatchObject({ status: 409, json: { code: "BUSY" } });
  });
});
