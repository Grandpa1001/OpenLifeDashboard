// D52.5 — the server of the updater on real HTTP, a real journal and a fake view of the app (Architektura §11.2.1).
// AC1: a command through the channel is answered and moves the journal: status gives the record and the app, an
//      install is begun on the record and answered as accepted (the steps run in the background, D54.1), the fence it
//      carried is the one the journal holds afterwards, and a smaller fence is refused as a crashed writer, also after the process
//      restarts; a running operation is resumed by the same operation and refused for another.
// AC2: every refusal is a code and a status and nothing more: a bad signature, a replay, a stale and a malformed
//      command, a body over the bound, an unknown route and a wrong method; a command older than the process is stale
//      whatever its signature; an unreadable journal stops every command; the log holds no token, signature or body.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_HEALTH_PATH, UPDATER_SIGNATURE_HEADER, updaterStatusSchema, type UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { UPDATE_STATE_FILE } from "@openlife/contracts/updates/state";
import { afterEach, describe, expect, it } from "vitest";
import { createProgressHandler } from "../../../apps/updater/dist/install/progress.js";
import { createReleaseSwitcher } from "../../../apps/updater/dist/install/switch-release.js";
import { createReleasePreparer, type ReleasePreparer } from "../../../apps/updater/dist/install/prepare-release.js";
import { openJournal } from "../../../apps/updater/dist/journal/journal.js";
import { signCommand } from "../../../apps/updater/dist/protocol/verify-command.js";
import { createUpdaterServer, type AppView, type UpdaterLogEvent } from "../../../apps/updater/dist/server/updater-server.js";
import { initialRecord, transition } from "../../../apps/updater/dist/state-machine/transitions.js";

const TOKEN = randomBytes(32).toString("hex");
type Started = { url: string; close: () => Promise<void>; logs: UpdaterLogEvent[]; journalDir: string; setNow: (ms: number) => void };
const started: Started[] = [];
afterEach(async () => {
  for (const each of started.splice(0)) await each.close();
});

async function start(options: { journalDir?: string; startedAtMs?: number; nowMs?: number; app?: AppView; installer?: ReleasePreparer } = {}): Promise<Started> {
  const journalDir = options.journalDir ?? mkdtempSync(path.join(tmpdir(), "updater-server-"));
  const logs: UpdaterLogEvent[] = [];
  // Without a catalog the steps of an installation close it at once with a code, so the operations of these tests do not stay held.
  const installer = options.installer ?? createReleasePreparer({ journal: openJournal(journalDir), catalogDir: journalDir, scope: { pullVerified: async () => undefined }, nowIso: () => new Date().toISOString(), logger: { log: () => undefined } });
  let now = options.nowMs ?? Date.now();
  const server = createUpdaterServer({
    token: TOKEN,
    journal: openJournal(journalDir),
    appView: async () => (options.app === undefined ? { running: true, health: "healthy" } : options.app),
    nowMs: () => now,
    startedAtMs: options.startedAtMs ?? now - 1000,
    logger: { log: (event) => void logs.push(event) },
    installer,
    switcher: createReleaseSwitcher({ journal: openJournal(journalDir), catalogDir: journalDir, scope: { findApp: async () => ({ id: "a", name: "a" }), replaceApp: async (app) => ({ previousId: app.id, previousName: "a-previous", nextId: "b", name: app.name }) }, nowIso: () => new Date().toISOString(), logger: { log: () => undefined } }),
    progress: createProgressHandler({ journal: openJournal(journalDir), catalogDir: journalDir, backupDir: journalDir, previousSelection: async () => null, nowIso: () => new Date().toISOString() }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const instance: Started = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(() => resolve())), logs, journalDir, setNow: (ms) => void (now = ms) };
  started.push(instance);
  return instance;
}

const envelopeOf = (command: UpdaterEnvelope["command"], issuedAt = Date.now(), operationId: string = randomUUID()): UpdaterEnvelope => ({ v: 1, operationId, issuedAt, nonce: randomBytes(24).toString("base64url"), command });
async function send(server: Started, envelope: UpdaterEnvelope, over: { body?: string; signature?: string | null; method?: string; path?: string } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = over.body ?? JSON.stringify(envelope);
  const signature = over.signature === undefined ? signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body }) : over.signature;
  const reply = await fetch(`${server.url}${over.path ?? UPDATER_COMMAND_PATH}`, { method: over.method ?? "POST", headers: { "Content-Type": "application/json", ...(signature === null ? {} : { [UPDATER_SIGNATURE_HEADER]: signature }) }, ...(over.method === "GET" ? {} : { body }) });
  return { status: reply.status, json: (await reply.json()) as Record<string, unknown> };
}
const install = (fence: number, issuedAt?: number, operationId?: string) => envelopeOf({ type: "install", release: "1.2.3", fence }, issuedAt, operationId);
const recordOf = (dir: string) => {
  const read = openJournal(dir).read();
  return read.ok ? read.record : null;
};

describe("D52.5-AC1 a command moves the journal and the fence outlives the process", () => {
  it("answers a status with the record and the app, and the health route with ok", async () => {
    const server = await start();
    const status = await send(server, envelopeOf({ type: "status" }));
    expect(status.status).toBe(200);
    expect(updaterStatusSchema.parse(status.json)).toEqual({ state: "idle", operationId: null, fence: 0, targetRelease: null, error: null, app: { running: true, health: "healthy" } });
    expect(await (await fetch(`${server.url}${UPDATER_HEALTH_PATH}`)).json()).toEqual({ status: "ok" });
    // The app is not found: the status says so and still answers.
    const without = await start({ app: null });
    expect((await send(without, envelopeOf({ type: "status" }))).json["app"]).toBeNull();
  });

  it("begins an install on the journal, answers it as accepted, keeps the fence, refuses a smaller one and takes a larger", async () => {
    const server = await start();
    const first = await send(server, install(5));
    expect([first.status, first.json["state"], first.json["fence"]]).toEqual([202, "checking", 5]);
    expect(recordOf(server.journalDir)).toMatchObject({ state: "idle", fence: 5, targetRelease: "1.2.3", error: { code: "CATALOG_MISSING" } });
    expect(openJournal(server.journalDir).read()).toMatchObject({ ok: true, record: { seq: 2 } });
    expect(await send(server, install(4))).toMatchObject({ status: 409, json: { code: "STALE_FENCE" } });
    expect((await send(server, install(5))).status).toBe(202);
    expect((await send(server, install(9))).status).toBe(202);
    expect(recordOf(server.journalDir)?.fence).toBe(9);
  });

  it("keeps the fence after a restart of the process: the crashed writer is refused, the current one taken", async () => {
    const before = await start();
    await send(before, install(7));
    await before.close();
    const after = await start({ journalDir: before.journalDir, startedAtMs: Date.now() - 1000 });
    expect(await send(after, install(6))).toMatchObject({ status: 409, json: { code: "STALE_FENCE" } });
    expect((await send(after, install(7))).status).toBe(202);
    expect(updaterStatusSchema.parse((await send(after, envelopeOf({ type: "status" }))).json).fence).toBe(7);
  });

  it("resumes the operation that is running when the same one is asked again, and refuses another", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "updater-server-"));
    const operationId = randomUUID();
    const begun = transition(initialRecord(new Date().toISOString()), "checking", { operationId, targetRelease: "1.2.3", fence: 3 }, new Date().toISOString());
    if (!begun.ok) throw new Error("not begun");
    openJournal(dir).write(begun.record);
    const server = await start({ journalDir: dir, installer: { prepare: async () => undefined } });
    const same = await send(server, install(3, undefined, operationId));
    expect([same.status, same.json["state"], same.json["operationId"]]).toEqual([202, "checking", operationId]);
    expect(await send(server, install(3))).toMatchObject({ status: 409, json: { code: "BUSY" } });
    expect(recordOf(dir)).toMatchObject({ state: "checking", seq: 1 });
  });
});

describe("D52.5-AC2 a refusal is a code and nothing else, and nothing of the secret is logged", () => {
  it("refuses a bad signature, a replay, a stale and a malformed command, a body over the bound, another route and another method", async () => {
    const server = await start();
    const good = envelopeOf({ type: "status" });
    expect((await send(server, good)).status).toBe(200);
    expect(await send(server, good)).toMatchObject({ status: 401, json: { code: "REPLAYED" } });
    expect(await send(server, envelopeOf({ type: "status" }), { signature: "v1=" + "0".repeat(64) })).toMatchObject({ status: 401, json: { code: "BAD_SIGNATURE" } });
    expect(await send(server, envelopeOf({ type: "status" }), { signature: null })).toMatchObject({ status: 401, json: { code: "BAD_SIGNATURE" } });
    expect(await send(server, envelopeOf({ type: "status" }, Date.now() - 10 * 60 * 1000))).toMatchObject({ status: 401, json: { code: "STALE" } });
    expect(await send(server, good, { body: "not json" })).toMatchObject({ status: 400, json: { code: "MALFORMED" } });
    expect(await send(server, good, { body: JSON.stringify({ ...good, padding: "x".repeat(5000) }) })).toMatchObject({ status: 400, json: { code: "MALFORMED" } });
    expect(await send(server, good, { path: "/v1/other" })).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    expect(await send(server, good, { method: "GET" })).toMatchObject({ status: 405, json: { code: "METHOD_NOT_ALLOWED" } });
    for (const refusal of server.logs.filter((entry) => entry.event === "updater.command_refused")) expect(refusal.code).toMatch(/^[A-Z_]+$/);
  });

  it("refuses a validly signed command that is older than the process, whatever its time otherwise allows", async () => {
    const now = Date.now();
    const server = await start({ nowMs: now, startedAtMs: now });
    expect(await send(server, envelopeOf({ type: "status" }, now - 30_000))).toMatchObject({ status: 401, json: { code: "STALE" } });
    expect((await send(server, envelopeOf({ type: "status" }, now))).status).toBe(200);
  });

  it("stops every command while the journal cannot be read and writes nothing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "updater-server-"));
    writeFileSync(path.join(dir, UPDATE_STATE_FILE), "garbage");
    const server = await start({ journalDir: dir });
    expect(await send(server, envelopeOf({ type: "status" }))).toMatchObject({ status: 503, json: { code: "JOURNAL_UNREADABLE" } });
    expect(await send(server, install(1))).toMatchObject({ status: 503, json: { code: "JOURNAL_UNREADABLE" } });
    expect(openJournal(dir).read()).toEqual({ ok: false, code: "JOURNAL_UNREADABLE" });
  });

  it("holds no token, signature or body in the log", async () => {
    const server = await start();
    const envelope = install(2);
    const body = JSON.stringify(envelope);
    const signature = signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body });
    await send(server, envelope);
    await send(server, install(1));
    await send(server, envelopeOf({ type: "status" }), { signature: "v1=" + "1".repeat(64) });
    const text = JSON.stringify(server.logs);
    for (const secret of [TOKEN, signature, envelope.nonce, "v1="]) expect(text).not.toContain(secret);
    expect(server.logs.length).toBeGreaterThan(0);
  });
});
