// D53.2 — the client of the repository of the releases and the cache it keeps, against a real HTTP server of our own
// (Architektura §11.1).
// AC1: a 200 gives the stable releases and the ETag, a request with that ETag gets 304 and is no change; the request is
//      the one path of the repository with the headers of a client and no cookie or credential; a limit of the API
//      (429, or 403 with no calls left or a Retry-After) is a rate limit with the wait the server asked for, a plain 403
//      is a refusal that is no limit, 404 and 5xx and every other status have a code of their own; a redirect is not
//      followed (the target server is never asked); the network gone, a refused connection and a slow answer are network
//      failures; an answer that is too large, not JSON or not a list is invalid; a hostile entry (a draft, a prerelease, a
//      link of its own) is not a release; the base of the API must be HTTPS or loopback HTTP and the repository owner/name.
// AC2: the cache is written whole and read again by a new process, a torn temporary file, a damaged file, a link, a file
//      of another repository and one that is too large are no cache; a check folds the answer into the state: a success
//      clears the backoff, a failure lengthens it and keeps the releases and the ETag it knew, a limit waits as long as
//      it was told, a 304 keeps the releases, and a cache that cannot be written does not fail the check.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UPDATE_CHECK_CACHE_FILE, UPDATE_CHECK_CACHE_MAX_BYTES } from "@openlife/contracts/updates/check-cache";
import { BACKOFF_BASE_MS, INITIAL_CHECK_STATE } from "../../../packages/core/src/modules/updates/public.js";
import { afterEach, describe, expect, it } from "vitest";
import { openCheckCache } from "../../../apps/server/dist/adapters/updates/check-cache.js";
import { createReleaseChecker } from "../../../apps/server/dist/adapters/updates/release-checker.js";
import { createReleaseClient, parseApiBase } from "../../../apps/server/dist/adapters/updates/release-client.js";

const REPO = "owner/openlife-dashboard";
type Seen = { method: string | undefined; url: string | undefined; headers: http.IncomingHttpHeaders };
type Reply = { status: number; headers?: Record<string, string>; body?: string; delayMs?: number };
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});

async function serve(respond: (seen: Seen, count: number) => Reply): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers });
    const reply = respond(seen.at(-1)!, seen.length);
    setTimeout(() => {
      response.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
      response.end(reply.body ?? "");
    }, reply.delayMs ?? 0);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const item = (tag: string, over: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: "2026-11-10T12:00:00Z", body: `notes of ${tag}`, html_url: "https://evil.example/x", ...over });
const feed = (...tags: string[]) => JSON.stringify(tags.map((tag) => item(tag)));
const clientOf = (base: string, over: { timeoutMs?: number; nowMs?: () => number } = {}) => createReleaseClient({ repository: REPO, baseUrl: base, ...over });

describe("D53.2-AC1 the client asks once, believes little and tells the failure by a code", () => {
  it("gets the stable releases and the ETag with a 200, and a 304 for the same ETag, with the headers of a client only", async () => {
    const server = await serve((seen) => (seen.headers["if-none-match"] === '"abc"' ? { status: 304 } : { status: 200, headers: { ETag: '"abc"' }, body: feed("v1.0.0", "v1.1.0") }));
    const client = clientOf(server.url);
    const first = await client.check(null);
    expect(first).toMatchObject({ kind: "changed", etag: '"abc"', ignored: 0 });
    expect(first.kind === "changed" && first.releases.map((release) => release.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(await client.check('"abc"')).toEqual({ kind: "not_modified" });
    expect(server.seen.map((seen) => [seen.method, seen.url])).toEqual([["GET", `/repos/${REPO}/releases?per_page=100`], ["GET", `/repos/${REPO}/releases?per_page=100`]]);
    expect(server.seen[1]!.headers["if-none-match"]).toBe('"abc"');
    expect(server.seen[0]!.headers["if-none-match"]).toBeUndefined();
    for (const headers of server.seen.map((seen) => seen.headers)) {
      expect(headers["user-agent"]).toBe("openlife-dashboard");
      expect(headers["accept"]).toBe("application/vnd.github+json");
      expect(Object.keys(headers).filter((name) => ["cookie", "authorization", "proxy-authorization"].includes(name))).toEqual([]);
    }
  });

  it("is not a change when a 304 comes for a request that sent no ETag", async () => {
    const server = await serve(() => ({ status: 304 }));
    expect(await clientOf(server.url).check(null)).toMatchObject({ kind: "failed", code: "UNEXPECTED_STATUS" });
  });

  it("tells a limit of the API with the wait the server asked for, and a 403 that is no limit as a refusal", async () => {
    const NOW = Date.parse("2026-11-16T12:00:00Z");
    const cases: Array<[Reply, string, number | null]> = [
      [{ status: 429, headers: { "Retry-After": "90" } }, "RATE_LIMITED", 90_000],
      [{ status: 429 }, "RATE_LIMITED", null],
      [{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 1800) } }, "RATE_LIMITED", 1_800_000],
      [{ status: 403, headers: { "Retry-After": "10" } }, "RATE_LIMITED", 10_000],
    ];
    for (const [reply, code, wait] of cases) {
      const server = await serve(() => reply);
      expect(await clientOf(server.url, { nowMs: () => NOW }).check(null), JSON.stringify(reply)).toEqual({ kind: "failed", failure: "rate_limited", code, retryAfterMs: wait });
    }
    const forbidden = await serve(() => ({ status: 403, headers: { "x-ratelimit-remaining": "57" } }));
    expect(await clientOf(forbidden.url).check(null)).toEqual({ kind: "failed", failure: "invalid", code: "FORBIDDEN", retryAfterMs: null });
  });

  it("gives its own code to a missing repository, a server error, every other status and a redirect, and never follows the redirect", async () => {
    const target = await serve(() => ({ status: 200, body: feed("v9.9.9") }));
    const kinds: Array<[Reply, string, string]> = [
      [{ status: 404, body: "no such repo" }, "invalid", "NOT_FOUND"],
      [{ status: 500 }, "server", "SERVER_ERROR"],
      [{ status: 503 }, "server", "SERVER_ERROR"],
      [{ status: 418 }, "invalid", "UNEXPECTED_STATUS"],
      [{ status: 301, headers: { Location: `${target.url}/elsewhere` } }, "invalid", "REDIRECT_REFUSED"],
      [{ status: 307, headers: { Location: `${target.url}/elsewhere` } }, "invalid", "REDIRECT_REFUSED"],
    ];
    for (const [reply, failure, code] of kinds) {
      const server = await serve(() => reply);
      expect(await clientOf(server.url).check(null), JSON.stringify(reply)).toMatchObject({ kind: "failed", failure, code });
    }
    expect(target.seen).toEqual([]);
  });

  it("tells the network gone, a refused connection and a slow answer as network failures", async () => {
    const closed = await serve(() => ({ status: 200 }));
    const gone = clientOf(closed.url);
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
    expect(await gone.check(null)).toEqual({ kind: "failed", failure: "network", code: "NETWORK_UNAVAILABLE", retryAfterMs: null });
    const slow = await serve(() => ({ status: 200, body: feed("v1.0.0"), delayMs: 600 }));
    expect(await clientOf(slow.url, { timeoutMs: 100 }).check(null)).toEqual({ kind: "failed", failure: "network", code: "TIMEOUT", retryAfterMs: null });
  });

  it("refuses an answer that is too large, is not JSON or is not a list, and keeps nothing of what it said", async () => {
    const big = await serve(() => ({ status: 200, body: "[" + "0,".repeat(3 * 1024 * 1024) + "0]" }));
    expect(await clientOf(big.url).check(null)).toMatchObject({ kind: "failed", failure: "invalid", code: "RESPONSE_TOO_LARGE" });
    for (const body of ["<html>a proxy</html>", "{}", '"text"', "null", ""]) {
      const server = await serve(() => ({ status: 200, body }));
      expect(await clientOf(server.url).check(null), body).toEqual({ kind: "failed", failure: "invalid", code: "RESPONSE_INVALID", retryAfterMs: null });
    }
  });

  it("takes no draft, no prerelease and no link of the feed as a release", async () => {
    const server = await serve(() => ({ status: 200, body: JSON.stringify([item("v1.0.0"), item("v1.1.0", { draft: true }), item("v1.2.0", { prerelease: true }), item("v2.0.0-rc.1"), item("v1.3.0", { html_url: "https://evil.example/phish" })]) }));
    const result = await clientOf(server.url).check(null);
    expect(result.kind === "changed" && result.releases.map((release) => [release.version, release.url])).toEqual([["1.3.0", "https://github.com/owner/openlife-dashboard/releases/tag/v1.3.0"], ["1.0.0", "https://github.com/owner/openlife-dashboard/releases/tag/v1.0.0"]]);
    expect(result.kind === "changed" && result.ignored).toBe(3);
  });

  it("allows an HTTPS base and a loopback HTTP base only, with no credentials, path or query, and an owner/name repository only", () => {
    for (const good of ["https://api.github.com", "https://ghe.example.com:8443", "http://127.0.0.1:8080", "http://localhost:3000", "http://[::1]:9"]) expect(parseApiBase(good), good).toBeInstanceOf(URL);
    for (const bad of ["http://api.github.com", "http://evil.example", "ftp://127.0.0.1", "https://user:pw@api.github.com", "https://api.github.com/v3", "https://api.github.com?x=1", "https://api.github.com#x", "not a url", ""]) expect(parseApiBase(bad), bad).toBeUndefined();
    expect(() => createReleaseClient({ repository: REPO, baseUrl: "http://api.github.com" })).toThrow(RangeError);
    for (const repository of ["owner", "../../etc", "owner/name/extra", "https://github.com/o/n", "o n/x", ""]) expect(() => createReleaseClient({ repository, baseUrl: "https://api.github.com" }), repository).toThrow(RangeError);
  });
});

describe("D53.2-AC2 the cache and what a check makes of an answer", () => {
  const folder = (): string => mkdtempSync(path.join(tmpdir(), "update-check-"));
  const NOW = Date.parse("2026-11-16T12:00:00Z");
  function checkerOn(dir: string, base: string, nowMs: () => number = () => NOW, current = "1.0.0") {
    return createReleaseChecker({ repository: REPO, client: clientOf(base, { nowMs }), cache: openCheckCache(dir, REPO), currentVersion: current, nowMs });
  }

  it("starts from nothing, writes the answer whole and gives it to a new process", async () => {
    const dir = folder();
    const server = await serve(() => ({ status: 200, headers: { ETag: '"v1"' }, body: feed("v1.0.0", "v1.2.0") }));
    const checker = checkerOn(dir, server.url);
    expect(checker.snapshot()).toMatchObject({ releases: [], availability: { available: false, latest: null }, lastErrorCode: null });
    const outcome = await checker.run();
    expect(outcome).toMatchObject({ status: "updated", code: null, cacheWriteFailed: false, availability: { available: true, latest: { version: "1.2.0" } }, state: { failures: 0, lastSuccessAtMs: NOW, notBeforeMs: null } });
    const again = checkerOn(dir, server.url).snapshot();
    expect(again).toMatchObject({ availability: { available: true, latest: { version: "1.2.0" } }, state: { lastSuccessAtMs: NOW }, lastErrorCode: null });
    expect(JSON.parse(readFileSync(path.join(dir, UPDATE_CHECK_CACHE_FILE), "utf8")).etag).toBe('"v1"');
  });

  it("asks with the ETag it remembers, and a 304 keeps the releases it knew", async () => {
    const dir = folder();
    const server = await serve((seen) => (seen.headers["if-none-match"] === '"v1"' ? { status: 304 } : { status: 200, headers: { ETag: '"v1"' }, body: feed("v1.5.0") }));
    await checkerOn(dir, server.url).run();
    const later = await checkerOn(dir, server.url, () => NOW + 1000).run();
    expect(later).toMatchObject({ status: "unchanged", code: null, availability: { available: true, latest: { version: "1.5.0" } }, state: { lastSuccessAtMs: NOW + 1000, failures: 0 } });
    expect(server.seen.at(-1)!.headers["if-none-match"]).toBe('"v1"');
  });

  it("keeps the releases and the ETag when the network fails, lengthens the backoff, and clears it by the next success", async () => {
    const dir = folder();
    let mode: "ok" | "down" = "ok";
    const server = await serve(() => (mode === "ok" ? { status: 200, headers: { ETag: '"v1"' }, body: feed("v1.5.0") } : { status: 503 }));
    await checkerOn(dir, server.url).run();
    mode = "down";
    const first = await checkerOn(dir, server.url, () => NOW + 10).run();
    expect(first).toMatchObject({ status: "failed", code: "SERVER_ERROR", availability: { available: true, latest: { version: "1.5.0" } }, state: { failures: 1, notBeforeMs: NOW + 10 + BACKOFF_BASE_MS, rateLimited: false } });
    const second = await checkerOn(dir, server.url, () => NOW + 20).run();
    expect(second.state).toMatchObject({ failures: 2, notBeforeMs: NOW + 20 + 2 * BACKOFF_BASE_MS });
    expect(checkerOn(dir, server.url).snapshot()).toMatchObject({ lastErrorCode: "SERVER_ERROR" });
    expect(JSON.parse(readFileSync(path.join(dir, UPDATE_CHECK_CACHE_FILE), "utf8")).etag).toBe('"v1"');
    mode = "ok";
    expect(await checkerOn(dir, server.url, () => NOW + 30).run()).toMatchObject({ status: "updated", state: { failures: 0, notBeforeMs: null }, code: null });
  });

  it("waits as long as the limit of the API said and marks it as a limit", async () => {
    const dir = folder();
    const server = await serve(() => ({ status: 429, headers: { "Retry-After": "1800" } }));
    expect(await checkerOn(dir, server.url).run()).toMatchObject({ status: "failed", code: "RATE_LIMITED", state: { rateLimited: true, notBeforeMs: NOW + 1_800_000, failures: 1 } });
  });

  it("does not read a torn temporary file, a damaged file, a link, a file of another repository or one that is too large", async () => {
    const server = await serve(() => ({ status: 200, body: feed("v1.0.0") }));
    const dir = folder();
    await checkerOn(dir, server.url).run();
    const file = path.join(dir, UPDATE_CHECK_CACHE_FILE);
    const good = readFileSync(file, "utf8");
    writeFileSync(`${file}.tmp`, good.slice(0, 40));
    expect(checkerOn(dir, server.url).snapshot().releases).toHaveLength(1);
    writeFileSync(file, good.slice(0, good.length - 20));
    expect(checkerOn(dir, server.url).snapshot().releases).toEqual([]);
    writeFileSync(file, good.replace('"v":1', '"v":2'));
    expect(checkerOn(dir, server.url).snapshot().releases).toEqual([]);
    writeFileSync(file, good.replace(REPO, "someone/else"));
    expect(checkerOn(dir, server.url).snapshot().releases).toEqual([]);
    writeFileSync(file, `${good.trim()}${" ".repeat(UPDATE_CHECK_CACHE_MAX_BYTES)}`);
    expect(checkerOn(dir, server.url).snapshot().releases).toEqual([]);
    const linked = folder();
    writeFileSync(path.join(linked, "real.json"), good);
    symlinkSync(path.join(linked, "real.json"), path.join(linked, UPDATE_CHECK_CACHE_FILE));
    expect(checkerOn(linked, server.url).snapshot().releases).toEqual([]);
  });

  it("does not fail the check when the cache cannot be written, and says so", async () => {
    const server = await serve(() => ({ status: 200, body: feed("v1.2.0") }));
    const dir = folder();
    mkdirSync(path.join(dir, `${UPDATE_CHECK_CACHE_FILE}.tmp`));
    const outcome = await checkerOn(dir, server.url).run();
    expect(outcome).toMatchObject({ status: "updated", cacheWriteFailed: true, availability: { available: true, latest: { version: "1.2.0" } } });
    expect(INITIAL_CHECK_STATE.failures).toBe(0);
  });
});
