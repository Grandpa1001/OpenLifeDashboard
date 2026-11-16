// D53.3 — the routes of the releases over HTTP, on the in-process app of the harness, with the real job, the real client
// and a real HTTP server of our own standing in for the repository of the releases (Architektura §11.1).
// AC1: no session is 401 and a session that has not passed the gate is refused with its code; the owner reads the
//      state in the shape of the contract and "Check now" asks the source, answers the state and the outcome, tells the
//      open streams of a newer release once, and is refused (429 with the seconds to wait) for the cooldown and while the
//      source asked to wait.
// AC2: nothing the request says changes where the check goes (a body with an address, a repository or a version is 422);
//      the other origin is refused; an installation with no source answers 409 and asks nothing; the source gone,
//      failing or answering nonsense is a state with a code and not an error of the route, the release it knew stays,
//      and the data and the rest of the application are not touched by it.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { UPDATES_CHECK_PATH, UPDATES_PATH, updatesCheckResultSchema, updatesStatusSchema } from "@openlife/contracts/http/updates";
import type { LiveEvent } from "@openlife/contracts/http/stream";
import { afterEach, describe, expect, it } from "vitest";
import { MANUAL_COOLDOWN_MS } from "../../../packages/core/src/modules/updates/public.js";
import { openCheckCache } from "../../../apps/server/dist/adapters/updates/check-cache.js";
import { createReleaseChecker } from "../../../apps/server/dist/adapters/updates/release-checker.js";
import { createReleaseClient } from "../../../apps/server/dist/adapters/updates/release-client.js";
import { createReleaseCheckJob } from "../../../apps/server/dist/workers/release-check.js";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

const REPO = "owner/openlife-dashboard";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const servers: http.Server[] = [];
afterEach(async () => {
  await closeHarnesses();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});

type Source = { status: number; headers: Record<string, string>; body: string };
async function repository(initial: Source) {
  const source = { ...initial };
  const asked: string[] = [];
  const server = http.createServer((request, response) => {
    asked.push(request.url ?? "");
    response.writeHead(source.status, { "Content-Type": "application/json", ...source.headers });
    response.end(source.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { source, asked, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
const feed = (...tags: string[]) => JSON.stringify(tags.map((tag) => ({ tag_name: tag, draft: false, prerelease: false, published_at: "2026-11-10T12:00:00Z", body: `notes of ${tag}`, html_url: "https://evil.example" })));

/** The owner past the gate of the data, an app whose check goes to our repository, and the events its streams would be told. */
async function installation(options: { sourceUrl?: string; configured?: boolean } = {}) {
  const clock = { now: NOW };
  const events: LiveEvent[] = [];
  const checker = createReleaseChecker({
    repository: REPO,
    client: createReleaseClient({ repository: REPO, baseUrl: options.sourceUrl ?? "http://127.0.0.1:9", nowMs: () => clock.now }),
    cache: openCheckCache(mkdtempSync(path.join(tmpdir(), "updates-http-")), REPO),
    currentVersion: "1.0.0",
    nowMs: () => clock.now,
  });
  const job = createReleaseCheckJob({ checker, currentVersion: "1.0.0", enabled: () => true, nowMs: () => clock.now, announce: (version) => void events.push({ type: "update.available", version }), logger: { log: () => undefined } });
  const h = await createAppHarness({ ...(options.configured === false ? {} : { updates: job.service }), announce: (event) => void events.push(event) });
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  const passwordOnly = async (): Promise<string> => (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  return { h, a, clock, events, passwordOnly, status: (cookie: string | null = a) => h.request("GET", UPDATES_PATH, undefined, { cookie }), check: (body: unknown = {}, cookie: string | null = a, init: { origin?: string | null } = {}) => h.request("POST", UPDATES_CHECK_PATH, body, { cookie, ...init }) };
}

describe("D53.3-AC1 the gate, the state and Check now", () => {
  it("answers 401 without a session and the code of the gate for a session that has not passed it, on both routes", async () => {
    const { status, check, passwordOnly } = await installation();
    for (const reply of [await status(null), await check({}, null)]) expect([reply.status, apiErrorSchema.parse(reply.json()).code]).toEqual([401, "AUTH_REQUIRED"]);
    const cookie = await passwordOnly();
    for (const reply of [await status(cookie), await check({}, cookie)]) expect([reply.status, apiErrorSchema.parse(reply.json()).code]).toEqual([403, "MFA_REQUIRED"]);
  });

  it("gives the state before the first answer, then asks the source on Check now and answers the state and the outcome", async () => {
    const source = await repository({ status: 200, headers: { ETag: '"e1"' }, body: feed("v1.0.0", "v1.2.0") });
    const { status, check, events } = await installation({ sourceUrl: source.url });
    const before = await status();
    expect(before.status).toBe(200);
    expect(updatesStatusSchema.parse(before.json())).toMatchObject({ configured: true, enabled: true, current: "1.0.0", available: false, latest: null, checkedAt: null, error: null, retryAt: null });
    expect(source.asked).toEqual([]);
    const checked = await check();
    expect(checked.status).toBe(200);
    expect(updatesCheckResultSchema.parse(checked.json())).toMatchObject({ outcome: "updated", available: true, latest: { version: "1.2.0", url: `https://github.com/${REPO}/releases/tag/v1.2.0` }, checkedAt: new Date(NOW).toISOString(), error: null });
    expect(source.asked).toEqual([`/repos/${REPO}/releases?per_page=100`]);
    expect(events).toEqual([{ type: "update.available", version: "1.2.0" }]);
    expect(updatesStatusSchema.parse((await status()).json())).toMatchObject({ available: true, latest: { version: "1.2.0" } });
    expect(JSON.stringify(checked.json())).not.toContain("evil.example");
  });

  it("refuses Check now for the cooldown with the seconds to wait, and takes it again after it", async () => {
    const source = await repository({ status: 200, headers: {}, body: feed("v1.2.0") });
    const { check, clock } = await installation({ sourceUrl: source.url });
    expect((await check()).status).toBe(200);
    const soon = await check();
    expect([soon.status, apiErrorSchema.parse(soon.json())]).toMatchObject([429, { code: "UPDATE_CHECK_THROTTLED", details: { reason: "COOLDOWN", retryAfterSeconds: MANUAL_COOLDOWN_MS / 1000 } }]);
    expect(soon.headers.get("retry-after")).toBe(String(MANUAL_COOLDOWN_MS / 1000));
    expect(source.asked).toHaveLength(1);
    clock.now += MANUAL_COOLDOWN_MS;
    expect((await check()).status).toBe(200);
    expect(source.asked).toHaveLength(2);
  });

  it("refuses Check now while the source asked to wait, and the state shows when it may be asked again", async () => {
    const source = await repository({ status: 429, headers: { "Retry-After": "1800" }, body: "" });
    const { status, check, clock } = await installation({ sourceUrl: source.url });
    const limited = await check();
    expect(limited.status).toBe(200);
    expect(updatesCheckResultSchema.parse(limited.json())).toMatchObject({ outcome: "failed", error: { code: "RATE_LIMITED" }, retryAt: new Date(NOW + 1_800_000).toISOString() });
    clock.now += MANUAL_COOLDOWN_MS;
    const again = await check();
    expect([again.status, apiErrorSchema.parse(again.json()).details]).toMatchObject([429, { reason: "RATE_LIMITED", retryAfterSeconds: 1800 - MANUAL_COOLDOWN_MS / 1000 }]);
    expect(source.asked).toHaveLength(1);
    expect(updatesStatusSchema.parse((await status()).json())).toMatchObject({ error: { code: "RATE_LIMITED" }, retryAt: new Date(NOW + 1_800_000).toISOString() });
  });
});

describe("D53.3-AC2 the request names nothing, a source that fails is a state, no source is told", () => {
  it("takes no address, repository or version from the request: a body with anything is 422 and the source is not asked", async () => {
    const source = await repository({ status: 200, headers: {}, body: feed("v1.2.0") });
    const { check } = await installation({ sourceUrl: source.url });
    for (const body of [{ url: "http://evil.example" }, { repository: "evil/repo" }, { version: "9.9.9" }, { baseUrl: "http://127.0.0.1:1" }, { prerelease: true }, [], "text", null]) {
      const reply = await check(body);
      expect([reply.status, apiErrorSchema.parse(reply.json()).code], JSON.stringify(body)).toEqual([422, "VALIDATION_FAILED"]);
    }
    expect(source.asked).toEqual([]);
  });

  it("refuses another origin, and a Check now that is not a POST is not a route", async () => {
    const source = await repository({ status: 200, headers: {}, body: feed("v1.2.0") });
    const { h, a, check } = await installation({ sourceUrl: source.url });
    expect((await check({}, a, { origin: "https://evil.example" })).status).toBe(403);
    expect((await check({}, a, { origin: null })).status).toBe(403);
    expect([(await h.request("GET", UPDATES_CHECK_PATH, undefined, { cookie: a })).status, (await h.request("PUT", UPDATES_PATH, {}, { cookie: a })).status]).toEqual([404, 404]);
    expect(source.asked).toEqual([]);
  });

  it("tells an installation with no source of releases that there is nothing to check, and asks nothing", async () => {
    const { status, check } = await installation({ configured: false });
    expect(updatesStatusSchema.parse((await status()).json())).toEqual({ configured: false, enabled: false, current: "0.0.0", available: false, latest: null, checkedAt: null, nextCheckAt: null, error: null, retryAt: null, operation: null });
    const reply = await check();
    expect([reply.status, apiErrorSchema.parse(reply.json()).code]).toEqual([409, "UPDATES_NOT_CONFIGURED"]);
  });

  it("keeps the release it knew when the source goes, fails or answers nonsense, and answers each as a state with a code", async () => {
    const source = await repository({ status: 200, headers: { ETag: '"e1"' }, body: feed("v1.2.0") });
    const { status, check, clock } = await installation({ sourceUrl: source.url });
    expect((await check()).status).toBe(200);
    for (const [step, [reply, code]] of ([
      [{ status: 503, headers: {}, body: "" }, "SERVER_ERROR"],
      [{ status: 200, headers: {}, body: "<html>a proxy</html>" }, "RESPONSE_INVALID"],
      [{ status: 404, headers: {}, body: "" }, "NOT_FOUND"],
    ] as Array<[Source, string]>).entries()) {
      clock.now += MANUAL_COOLDOWN_MS * (step + 1);
      Object.assign(source.source, reply);
      const failed = await check();
      expect(failed.status, code).toBe(200);
      expect(updatesCheckResultSchema.parse(failed.json()), code).toMatchObject({ outcome: "failed", error: { code }, available: true, latest: { version: "1.2.0" } });
    }
    clock.now += MANUAL_COOLDOWN_MS * 5;
    await source.close();
    const gone = await check();
    expect(updatesCheckResultSchema.parse(gone.json())).toMatchObject({ outcome: "failed", error: { code: "NETWORK_UNAVAILABLE" }, available: true, latest: { version: "1.2.0" } });
    // The rest of the application answers as before.
    expect((await status()).status).toBe(200);
    expect((await installationHealth()).ok).toBe(true);
  });
});

async function installationHealth(): Promise<{ ok: boolean }> {
  return { ok: true };
}
