// D54.4 — the start of an update up to the switch, on the real application of the harness, the real server of the updater
// (a real journal, catalog and backup folder; a fake Engine that records every request) and the real copy of the database
// (Architektura §11.2.2 steps 1 to 4; DEV §9.53).
// AC1: the owner with a fresh second factor starts the update to the release the last check found: the updater pulls while
//      the app serves, the app closes its writes, takes the `pre_update` copy and the updater enters `switching` with the copy,
//      the pins before and the versions of the schema; the state is read from the journal of the updater, the start is audited
//      without a secret, a second operation is refused, the same operation asked again is the same one, and a version that
//      is not the available one, a request without the factor or a body that names more than a version start nothing.
// AC2: a copy that fails, a release the updater refuses, an updater that cannot be reached and a lost answer leave A whole:
//      the writes are open, no operation is held, the reason is told, and a lost answer starts one operation, not two.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { UPDATES_INSTALL_PATH, UPDATES_PATH, updatesInstallResultSchema, updatesStatusSchema } from "@openlife/contracts/http/updates";
import { afterEach, describe, expect, it } from "vitest";
import { catalogFileTextOf } from "../../../apps/updater/dist/release/catalog.js";
import { codeOf, secretOf } from "../../support/auth-http.ts";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type HarnessOptions } from "../../support/app-harness.ts";
import { catalogOf, closeServers, fakeEngine, install, recordOf, release123, send, start, TOKEN, type Engine, type Started } from "../../support/updater-harness.ts";

afterEach(async () => {
  await closeServers();
  closeHarnesses();
  for (const server of proxies.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});

const proxies: Server[] = [];
const RELEASE = "1.3.0";
const catalog = catalogFileTextOf(catalogOf(release123, { ...release123, version: RELEASE, schemaVersion: 8 }));

type Rig = Awaited<ReturnType<typeof rig>>;

/** The app, the updater and the folder of the copies they both look at; the owner has passed the factor and chosen the empty start. */
async function rig(options: { engine?: Engine; available?: () => string | null; updaterUrl?: (real: string) => Promise<string> | string; snapshots?: NonNullable<HarnessOptions["updater"]>["snapshots"]; catalog?: string | null; attempts?: number } = {}) {
  const backupsDir = mkdtempSync(path.join(tmpdir(), "update-start-"));
  const updater = await start({ catalog: options.catalog === undefined ? catalog : options.catalog, backupDir: backupsDir, ...(options.engine === undefined ? {} : { engine: options.engine }) });
  const baseUrl = options.updaterUrl === undefined ? updater.url : await options.updaterUrl(updater.url);
  const h = await createAppHarness({
    backupsDir,
    updater: { baseUrl, token: TOKEN, availableRelease: options.available ?? (() => RELEASE), ...(options.snapshots === undefined ? {} : { snapshots: options.snapshots }), ...(options.attempts === undefined ? {} : { attempts: options.attempts }) },
  });
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const cookie = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: (confirmed.json() as { batchId: string }).batchId }, { cookie });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie });
  return {
    h,
    updater,
    backupsDir,
    cookie,
    install: (body: unknown = { release: RELEASE }, as: string | null = cookie) => h.request("POST", UPDATES_INSTALL_PATH, body, { cookie: as }),
    status: () => h.request("GET", UPDATES_PATH, undefined, { cookie }),
    audits: () => h.rows<{ entity_id: string; details: string }>("SELECT entity_id, details FROM audit_log WHERE action = 'update.started'"),
    packages: () => readdirSync(backupsDir).filter((name) => !name.startsWith(".")),
  };
}
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const requestsOf = (updater: Started, prefix: string): number => updater.engine.requests.filter((request) => request.path.startsWith(prefix)).length;

/** An engine that holds every pull until the test lets it go, so the app is seen while the updater pulls. */
function heldEngine(): { engine: Engine; letGo: () => void } {
  const engine = fakeEngine();
  const original = engine.client.request;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  engine.client = { request: async (method, requestPath, body) => (method === "POST" ? gate.then(() => original(method, requestPath, body)) : original(method, requestPath, body)) };
  return { engine, letGo: release };
}

describe("D54.4-AC1 the start goes to the switch, once, and only for the release that was found", () => {
  it("pulls while the app serves, closes the writes, takes the copy and enters switching with the copy, the pins and the schema versions", async () => {
    const { engine, letGo } = heldEngine();
    const r = await rig({ engine });
    const started = await r.install();
    expect(started.status).toBe(202);
    const { operationId } = updatesInstallResultSchema.parse(started.json());
    // The updater pulls and the app has not closed anything: a write still goes through, and the state is the updater's.
    expect(r.h.gate.current().activeOperation).toBeNull();
    expect((await r.h.request("POST", "/api/v1/security/sessions/revoke-others", {}, { cookie: r.cookie })).status).not.toBe(503);
    expect(updatesStatusSchema.parse((await r.status()).json()).operation).toMatchObject({ operationId, state: "pulling", targetRelease: RELEASE, error: null });

    letGo();
    await r.h.coordinator!.settled();
    const record = recordOf(r.updater.dir)!;
    const [name] = r.packages();
    expect(r.packages()).toHaveLength(1);
    expect(name).toMatch(/-pre_update-/);
    expect(record).toMatchObject({ state: "switching", operationId, targetRelease: RELEASE, backupId: name, schemaVersionTo: 8, committed: false, error: null });
    expect(record.previousSelection).toEqual({ app: record.previousDigest, updater: null });
    expect(record.schemaVersionFrom).toBe((JSON.parse(readFileSync(path.join(r.backupsDir, name!, "meta.json"), "utf8")) as { schemaVersion: number }).schemaVersion);
    // The gate holds the operation with the fence the updater has, and the writes are closed.
    expect(r.h.gate.current()).toMatchObject({ generation: record.fence, activeOperation: { reason: "update", phase: "switching", operationId, targetRelease: RELEASE } });
    expect((await r.h.request("POST", "/api/v1/security/sessions/revoke-others", {}, { cookie: r.cookie })).status).toBe(503);
    // The state comes from the journal of the updater, also while the writes are closed.
    expect(updatesStatusSchema.parse((await r.status()).json()).operation).toMatchObject({ operationId, state: "switching", targetRelease: RELEASE });
    // The Engine was asked for the pulls and nothing that touches a container.
    expect(requestsOf(r.updater, "/containers")).toBe(0);
  });

  it("audits the start once with the release and the operation and nothing secret", async () => {
    const r = await rig();
    const operationId = updatesInstallResultSchema.parse((await r.install()).json()).operationId;
    await r.h.coordinator!.settled();
    const rows = r.audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(operationId);
    expect(JSON.parse(rows[0]!.details)).toEqual({ release: RELEASE, operationId });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it("refuses a second operation while one is going and answers the same operation again as the same one", async () => {
    const { engine, letGo } = heldEngine();
    const r = await rig({ engine });
    const first = updatesInstallResultSchema.parse((await r.install()).json());
    const other = await r.install();
    expect([other.status, code(other)]).toEqual([409, "UPDATE_IN_PROGRESS"]);
    const again = await r.install({ release: RELEASE, operationId: first.operationId });
    expect([again.status, updatesInstallResultSchema.parse(again.json()).operationId]).toEqual([202, first.operationId]);
    letGo();
    await r.h.coordinator!.settled();
    expect(recordOf(r.updater.dir)).toMatchObject({ state: "switching", operationId: first.operationId, seq: 5 });
    expect(r.audits()).toHaveLength(1);
    // Once the writes are closed the same request is told that maintenance is on.
    expect((await r.install()).status).toBe(503);
  });

  it("starts nothing for a version that is not the available one, without a fresh factor, without a session, with another origin or with more than a version", async () => {
    const r = await rig();
    const unknown = await r.install({ release: "9.9.9" });
    expect([unknown.status, code(unknown)]).toEqual([409, "UPDATE_RELEASE_UNKNOWN"]);
    for (const body of [{ release: RELEASE, image: "evil.example/app@sha256:" + "a".repeat(64) }, { release: "latest" }, { release: "../../etc" }, {}]) expect((await r.install(body)).status).toBe(422);
    expect((await r.install(undefined, null)).status).toBe(401);
    const foreign = await r.h.request("POST", UPDATES_INSTALL_PATH, { release: RELEASE }, { cookie: r.cookie, origin: "http://evil.example" });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    const password = (await r.h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
    const factorless = await r.install({ release: RELEASE }, password);
    expect([factorless.status, code(factorless)]).toEqual([403, "MFA_REQUIRED"]);
    r.h.sql("UPDATE session_ext SET totp_verified_at_ms = totp_verified_at_ms - 600000");
    const stale = await r.install();
    expect([stale.status, code(stale)]).toEqual([403, "STEP_UP_REQUIRED"]);
    // Nothing reached the updater, nothing was audited and the gate was not touched.
    expect(recordOf(r.updater.dir)).toBeNull();
    expect(r.updater.engine.requests).toEqual([]);
    expect(r.audits()).toHaveLength(0);
    expect(r.h.gate.current().activeOperation).toBeNull();
    expect(r.packages()).toEqual([]);
  });

  it("says an installation with no updater has nothing to start", async () => {
    const h = await createAppHarness();
    const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
    const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
    const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
    const cookie = confirmed.cookie ?? "";
    await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: (confirmed.json() as { batchId: string }).batchId }, { cookie });
    await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie });
    const reply = await h.request("POST", UPDATES_INSTALL_PATH, { release: RELEASE }, { cookie });
    expect([reply.status, code(reply)]).toEqual([409, "UPDATES_NOT_CONFIGURED"]);
    expect(updatesStatusSchema.parse((await h.request("GET", UPDATES_PATH, undefined, { cookie })).json()).operation).toBeNull();
  });
});

describe("D54.4-AC2 a failure leaves A whole and says why", () => {
  const writesOpen = async (r: Rig): Promise<void> => {
    expect(r.h.gate.current().activeOperation).toBeNull();
    expect((await r.h.request("POST", "/api/v1/security/sessions/revoke-others", {}, { cookie: r.cookie })).status).not.toBe(503);
  };

  it("gives the operation up and opens the writes when the copy fails, with no package and the updater back at idle", async () => {
    const r = await rig({ snapshots: { create: async () => ({ ok: false, code: "SNAPSHOT_FAILED" }) } });
    expect((await r.install()).status).toBe(202);
    await r.h.coordinator!.settled();
    expect(r.h.coordinator!.progress()).toMatchObject({ phase: "failed", code: "SNAPSHOT_FAILED" });
    expect(recordOf(r.updater.dir)).toMatchObject({ state: "idle", error: { code: "ABORTED" }, backupId: null, previousSelection: null });
    expect(r.packages()).toEqual([]);
    expect(requestsOf(r.updater, "/containers")).toBe(0);
    await writesOpen(r);
    // The next start is taken, with a clean record.
    expect((await r.install()).status).toBe(202);
    await r.h.coordinator!.settled();
  });

  it("tells a release the updater does not list, with the writes never closed", async () => {
    const r = await rig({ catalog: catalogFileTextOf(catalogOf(release123)) });
    expect((await r.install()).status).toBe(202);
    await r.h.coordinator!.settled();
    expect(r.h.coordinator!.progress()).toMatchObject({ phase: "failed", code: "RELEASE_UNKNOWN" });
    expect(updatesStatusSchema.parse((await r.status()).json()).operation).toMatchObject({ state: "idle", targetRelease: RELEASE, error: { code: "RELEASE_UNKNOWN" } });
    expect(r.packages()).toEqual([]);
    await writesOpen(r);
  });

  it("answers 503 when the updater cannot be reached, and when it refuses the operation, and holds nothing", async () => {
    const gone = await rig({ updaterUrl: () => "http://127.0.0.1:1" });
    const unreachable = await gone.install();
    expect([unreachable.status, code(unreachable)]).toEqual([503, "UPDATE_UNAVAILABLE"]);
    expect(updatesStatusSchema.parse((await gone.status()).json()).operation).toBeNull();
    await writesOpen(gone);
    expect((await gone.install({ release: RELEASE })).status).toBe(503);

    const busy = await rig();
    // The updater is held by another operation: it refuses this one, and the app starts nothing.
    expect((await send(busy.updater, install(RELEASE, 1))).status).toBe(202);
    const refused = await busy.install();
    expect([refused.status, code(refused)]).toEqual([503, "UPDATE_UNAVAILABLE"]);
    expect(apiErrorSchema.parse(refused.json()).details).toMatchObject({ code: "BUSY" });
    expect(busy.h.coordinator!.progress()).toBeNull();
    await writesOpen(busy);
  });

  it("starts one operation when the answer to the install is lost and the app sends it again", async () => {
    let seen = 0;
    const r = await rig({
      updaterUrl: async (real) => {
        const proxy = createServer((request, response) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(chunk as Buffer);
            const reply = await fetch(`${real}${request.url ?? ""}`, { method: request.method ?? "POST", headers: { "Content-Type": "application/json", "x-openlife-signature": String(request.headers["x-openlife-signature"]) }, body: Buffer.concat(chunks) });
            const text = await reply.text();
            seen += 1;
            // The first answer is lost: the updater has done what was asked and the app is not told.
            if (seen === 1) {
              request.socket.destroy();
              return;
            }
            response.writeHead(reply.status, { "Content-Type": "application/json" }).end(text);
          })();
        });
        proxies.push(proxy);
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      },
    });
    const started = await r.install();
    expect(started.status).toBe(202);
    await r.h.coordinator!.settled();
    expect(recordOf(r.updater.dir)).toMatchObject({ state: "switching", operationId: updatesInstallResultSchema.parse(started.json()).operationId });
    expect(r.packages()).toHaveLength(1);
    // The updater was asked twice and made one operation: its record counts one beginning.
    expect(requestsOf(r.updater, "/images/create")).toBe(1);
  });
});

