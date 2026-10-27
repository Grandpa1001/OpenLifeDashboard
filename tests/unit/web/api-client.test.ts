// D12.1 — the typed client of the SPA (apps/web/src/lib/api-client): every outcome is a result the
// screens can show without looking at a raw body.
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../../apps/web/src/lib/api-client/request.js";

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const stubFetch = (response: Response | (() => Promise<Response>)) => {
  const fetchMock = vi.fn(typeof response === "function" ? response : () => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
const call = (init: { body?: unknown; signal?: AbortSignal } = {}) =>
  apiRequest({ method: "POST", path: "/api/x", schema: identityStatusSchema, ...init });

describe("D12.1 the typed client", () => {
  it("a good answer is parsed with its contract", async () => {
    stubFetch(answer(200, { authenticated: true, nextAction: "ready" }));
    expect(await call()).toEqual({ ok: true, value: { authenticated: true, nextAction: "ready" } });
  });

  it("the body is sent as given, with no trimming or normalizing, and without caching or other credentials than the cookie", async () => {
    const fetchMock = stubFetch(answer(200, { authenticated: false, nextAction: "login" }));
    await call({ body: { email: "  Owner@Example.test ", password: "  spaced password  " } });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/x");
    expect(JSON.parse(String(init.body))).toEqual({ email: "  Owner@Example.test ", password: "  spaced password  " });
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("an API error becomes its code, status, request id and Retry-After seconds, and never the server's message", async () => {
    stubFetch(answer(429, { code: "AUTH_LOCKED", message: "words of the server", details: { retryAfterSeconds: 900 }, requestId: "req-1" }, { "Retry-After": "900" }));
    const result = await call();
    expect(result).toEqual({ ok: false, failure: { kind: "api", status: 429, code: "AUTH_LOCKED", requestId: "req-1", retryAfterSeconds: 900 } });
    expect(JSON.stringify(result)).not.toContain("words of the server");
  });

  it.each([
    ["an unknown code", answer(418, { code: "TEAPOT", message: "m", details: null, requestId: "r" })],
    ["a body that is not the error contract", answer(500, { oops: true })],
    ["a body that is not JSON", answer(502, "<html>bad gateway</html>")],
  ])("%s is UNKNOWN, with whatever request id is trustworthy", async (_name, response) => {
    stubFetch(response);
    const result = await call();
    expect(result).toMatchObject({ ok: false, failure: { kind: "api", code: "UNKNOWN" } });
  });

  it("a Retry-After that is not a plain number of seconds is ignored", async () => {
    stubFetch(answer(429, { code: "RATE_LIMITED", message: "m", details: null, requestId: "r" }, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }));
    expect(await call()).toMatchObject({ failure: { code: "RATE_LIMITED", retryAfterSeconds: null } });
  });

  it("an answer off the contract is not believed", async () => {
    for (const body of [{ authenticated: true, nextAction: "admin" }, { authenticated: "yes", nextAction: "ready" }, { authenticated: true, nextAction: "ready", token: "secret" }, "nope"]) {
      stubFetch(answer(200, body));
      expect(await call()).toEqual({ ok: false, failure: { kind: "invalid-response", status: 200 } });
    }
  });

  it("no connection is its own failure; an aborted request is another, so a late result can be ignored", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(await call()).toEqual({ ok: false, failure: { kind: "network" } });
    const controller = new AbortController();
    stubFetch(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    expect(await call({ signal: controller.signal })).toEqual({ ok: false, failure: { kind: "aborted" } });
  });

  it("an answer without a body is accepted when the contract has none", async () => {
    stubFetch(new Response(null, { status: 204 }));
    expect(await apiRequest({ method: "POST", path: "/api/auth/sign-out", body: {}, schema: null })).toEqual({ ok: true, value: null });
  });
});
