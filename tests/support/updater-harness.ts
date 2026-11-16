// The server of the updater on real HTTP for the tests of D54 (Architektura §11.2.1): a real journal, a real catalog and
// backup folder, a fake Engine that records every request, and signed commands made as the app makes them.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_SIGNATURE_HEADER, type UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { RELEASE_CATALOG_FILE, type ReleaseCatalog } from "@openlife/contracts/updates/catalog";
import type { UpdateRecord } from "@openlife/contracts/updates/state";
import type { EngineClient, EngineReply } from "../../apps/updater/dist/docker/engine-client.js";
import { createProjectScope } from "../../apps/updater/dist/docker/project-scope.js";
import { createReleasePreparer } from "../../apps/updater/dist/install/prepare-release.js";
import { createProgressHandler } from "../../apps/updater/dist/install/progress.js";
import { createReleaseSwitcher } from "../../apps/updater/dist/install/switch-release.js";
import { openJournal } from "../../apps/updater/dist/journal/journal.js";
import { signCommand } from "../../apps/updater/dist/protocol/verify-command.js";
import type { PreviousSelection } from "../../apps/updater/dist/release/previous-selection.js";
import { createUpdaterServer, type UpdaterLogEvent } from "../../apps/updater/dist/server/updater-server.js";

export const TOKEN = randomBytes(32).toString("hex");
export const digestOf = (seed: string): string => `sha256:${createHash("sha256").update(seed).digest("hex")}`;
export const APP = { repository: "registry.example.com/openlife/app", digest: digestOf("app 1.2.3") };
export const UPDATER = { repository: "registry.example.com/openlife/updater", digest: digestOf("updater 1.2.3") };
export const imageOf = (pin: { repository: string; digest: string }): string => `${pin.repository}@${pin.digest}`;
export const catalogOf = (...releases: ReleaseCatalog["releases"]): ReleaseCatalog => ({ v: 1, releases });
export const release123: ReleaseCatalog["releases"][number] = { version: "1.2.3", app: APP, updater: null, minFrom: null, schemaVersion: 7 };

export type Request = { method: string; path: string };
export type Engine = { client: EngineClient; requests: Request[]; pullAnswer: (image: string) => EngineReply; digestsOf: (image: string) => string[] };

/** An Engine that answers only what a pull needs, records everything it is asked, and lets a test choose what a pull and an inspection say. */
export function fakeEngine(): Engine {
  const requests: Request[] = [];
  const engine: Engine = {
    requests,
    pullAnswer: () => ({ status: 200, body: Buffer.from('{"status":"Pulling"}\n{"status":"Digest: ok"}\n') }),
    digestsOf: (image) => [image],
    client: {
      request: async (method, requestPath) => {
        requests.push({ method, path: requestPath });
        const pulled = /^\/images\/create\?fromImage=(.+)$/.exec(requestPath);
        if (method === "POST" && pulled) return engine.pullAnswer(decodeURIComponent(pulled[1]!));
        const inspected = /^\/images\/(.+)\/json$/.exec(requestPath);
        if (method === "GET" && inspected) return { status: 200, body: Buffer.from(JSON.stringify({ Id: digestOf("id"), RepoDigests: engine.digestsOf(decodeURIComponent(inspected[1]!)) })) };
        return { status: 500, body: Buffer.from('{"message":"not part of this test"}') };
      },
    },
  };
  return engine;
}

export type Started = { backupDir: string; url: string; dir: string; engine: Engine; logs: UpdaterLogEvent[]; close: () => Promise<void> };
const started: Started[] = [];
/** Closes every server a test started; each test file calls it in its own `afterEach`. */
export async function closeServers(): Promise<void> {
  for (const each of started.splice(0)) await each.close();
}

/** The app of the project as the updater's switch finds it, and what a replacement of it gives back; every call is recorded. */
export type SwitchScope = Parameters<typeof createReleaseSwitcher>[0]["scope"];
export function fakeSwitchScope(calls: Array<{ app: { id: string; name: string }; image: string }> = []): SwitchScope {
  return {
    findApp: async () => ({ id: "container-a", name: "openlife-app-1" }),
    replaceApp: async (app, image) => {
      calls.push({ app, image });
      return { previousId: app.id, previousName: `${app.name}-previous-1234`, nextId: "container-b", name: app.name };
    },
  };
}

/** A switch that never begins (the app is never found): the operation stays in `switching`, which is what the tests of the commands before it look at. */
export const idleSwitchScope: SwitchScope = { findApp: () => new Promise(() => undefined), replaceApp: () => new Promise(() => undefined) };

export async function start(options: { dir?: string; catalog?: string | null; engine?: Engine; backupDir?: string; previous?: PreviousSelection | null; switchScope?: SwitchScope } = {}): Promise<Started> {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "prepare-release-"));
  if (options.catalog !== undefined && options.catalog !== null) writeFileSync(path.join(dir, RELEASE_CATALOG_FILE), options.catalog);
  const engine = options.engine ?? fakeEngine();
  const backupDir = options.backupDir ?? path.join(dir, "backup");
  mkdirSync(backupDir, { recursive: true });
  const previous = options.previous === undefined ? { app: digestOf("app 1.0.0"), updater: null } : options.previous;
  const logs: UpdaterLogEvent[] = [];
  const logger = { log: (event: UpdaterLogEvent) => void logs.push(event) };
  const journal = openJournal(dir);
  const scope = createProjectScope({ client: engine.client, project: "openlife" });
  const server = createUpdaterServer({
    token: TOKEN,
    journal,
    appView: async () => ({ running: true, health: "healthy" }),
    nowMs: Date.now,
    startedAtMs: Date.now() - 1000,
    logger,
    installer: createReleasePreparer({ journal, catalogDir: dir, scope, nowIso: () => new Date().toISOString(), logger }),
    switcher: createReleaseSwitcher({ journal, catalogDir: dir, scope: options.switchScope ?? fakeSwitchScope(), nowIso: () => new Date().toISOString(), logger }),
    progress: createProgressHandler({ journal, catalogDir: dir, backupDir, previousSelection: async () => previous, nowIso: () => new Date().toISOString() }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const instance: Started = { backupDir, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, engine, logs, close: () => new Promise((resolve) => server.close(() => resolve())) };
  started.push(instance);
  return instance;
}

export const envelopeOf = (command: UpdaterEnvelope["command"], operationId: string = randomUUID()): UpdaterEnvelope => ({ v: 1, operationId, issuedAt: Date.now(), nonce: randomBytes(24).toString("base64url"), command });
export async function send(server: Started, envelope: UpdaterEnvelope): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = JSON.stringify(envelope);
  const signature = signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body });
  const reply = await fetch(`${server.url}${UPDATER_COMMAND_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", [UPDATER_SIGNATURE_HEADER]: signature }, body });
  return { status: reply.status, json: (await reply.json()) as Record<string, unknown> };
}
export const install = (release: string, fence = 1, operationId?: string) => envelopeOf({ type: "install", release, fence }, operationId);
export const recordOf = (dir: string): UpdateRecord | null => {
  const read = openJournal(dir).read();
  return read.ok ? read.record : null;
};
/** A published package of the backup folder as the store makes one: the files of its scope, the meta of a snapshot and the checksum of the meta. */
export function publishBackup(backupDir: string, over: { reason?: string; schemaVersion?: number; extraFile?: string; name?: string } = {}): string {
  const snapshotId = randomUUID();
  const reason = over.reason ?? "pre_update";
  const name = over.name ?? `20261116T120000Z-${reason}-${snapshotId}`;
  const dir = path.join(backupDir, name);
  mkdirSync(dir, { recursive: true });
  const meta = JSON.stringify({ metaVersion: 1, scope: "database", snapshotId, operationId: randomUUID(), instanceId: randomUUID(), reason, appVersion: "1.0.0", buildRevision: "abc1234", imageDigest: null, schemaVersion: over.schemaVersion ?? 7, startedAt: "2026-11-16T12:00:00.000Z", completedAt: "2026-11-16T12:00:01.000Z", databaseBytes: 8, requiresOriginalKeys: true });
  writeFileSync(path.join(dir, "app.db"), "database");
  writeFileSync(path.join(dir, "meta.json"), meta);
  writeFileSync(path.join(dir, "checksums.json"), JSON.stringify({ algorithm: "sha256", files: { "app.db": createHash("sha256").update("database").digest("hex"), "meta.json": createHash("sha256").update(meta).digest("hex") } }));
  if (over.extraFile !== undefined) writeFileSync(path.join(dir, over.extraFile), "x");
  return name;
}

/** The record once the operation has left the steps the updater drives by itself. */
export async function settled(server: Started): Promise<UpdateRecord> {
  for (let tries = 0; tries < 200; tries += 1) {
    const record = recordOf(server.dir);
    if (record !== null && record.state !== "checking" && record.state !== "pulling") return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the operation did not settle");
}

