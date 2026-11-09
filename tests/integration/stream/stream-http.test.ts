// D37.1 — the live stream over HTTP (Architektura §10, §9.4, §9.6; D37): `GET /api/v1/stream` opens
// only for a session that passes the gate, starts with `ready`, carries what the hub publishes and a
// `ping` every interval, holds five streams per session, and ends with the session or with the server.
// AC1: the headers of the stream, `ready` first, an event published after it, `ping` on the interval,
//      and every state before the gate refused with its own code and no stream left open.
// AC2: the sixth stream is 429 and a closed one frees its place; sign-out ends the streams of its
//      session at once, a session that disappeared ends its stream at the next ping, a client that does
//      not read is ended instead of buffered, and a stopping server ends the streams and exits.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { SIGN_OUT_PATH } from "@openlife/contracts/http/identity";
import { decodeLiveEvent, STREAM_PATH, type LiveEvent } from "@openlife/contracts/http/stream";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type HarnessOptions } from "../../support/app-harness.ts";
import { codeOf, installation, readyOwner, secretOf, send, stopServers, waitForExitOf } from "../../support/auth-http.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

/** Reads a stream block by block (a block ends with a blank line); `next` waits for the next event. */
function readerOf(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const next = async (timeoutMs = 3000): Promise<LiveEvent | "end"> => {
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const name = /^event: (.+)$/m.exec(block)?.[1] ?? "";
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        const event = decodeLiveEvent(name, data);
        if (event === null) throw new Error(`not an event of the contract: ${block}`);
        return event;
      }
      if (ended) return "end";
      const chunk = await Promise.race([reader.read(), new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs))]);
      if (chunk === "timeout") throw new Error("no event in time");
      if (chunk.done) ended = true;
      else buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, cancel: () => reader.cancel() };
}

async function ownerSession(options: HarnessOptions = {}) {
  const h = await createAppHarness(options);
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const cookie = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: (confirmed.json() as { batchId: string }).batchId }, { cookie });
  return { h, password, cookie, chooseEmpty: () => h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie }) };
}

describe("D37.1-AC1 the stream of a session that passed the gate", () => {
  it("answers as a stream that no proxy may hold, starts with ready, carries a published event and pings on the interval", async () => {
    const { h, cookie, chooseEmpty } = await ownerSession({ pingIntervalMs: 40 });
    await chooseEmpty();
    const response = await h.open(STREAM_PATH, { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const stream = readerOf(response);
    expect(await stream.next()).toEqual({ type: "ready" });
    expect(h.hub.count(await sessionIdOf(h, cookie))).toBe(1);

    h.hub.publish({ type: "data.changed", registry: "reg-1" });
    h.hub.publish({ type: "layout.changed", screenId: "scr-1" });
    const seen: LiveEvent[] = [];
    while (seen.length < 3) {
      const event = await stream.next();
      if (event === "end") throw new Error("the stream ended");
      seen.push(event);
    }
    // The events come in the order they were published; a ping may stand between them but never first of the published ones.
    expect(seen.filter((event) => event.type !== "ping")).toEqual([{ type: "data.changed", registry: "reg-1" }, { type: "layout.changed", screenId: "scr-1" }]);
    // Idle, the stream pings on its own.
    for (let pings = 0; pings < 2; ) {
      const event = await stream.next();
      if (event !== "end" && event.type === "ping") pings += 1;
    }
    await stream.cancel();
  });

  it("every state before the gate is refused with its own code, and no stream is left open", async () => {
    const { h, cookie, chooseEmpty } = await ownerSession();
    // A new sign-in has the password and not yet the second factor of the enrolled owner.
    const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
    const refused = async (route: string, withCookie: string | null) => {
      const reply = await h.request("GET", route, undefined, { cookie: withCookie });
      return { status: reply.status, code: apiErrorSchema.parse(reply.json()).code };
    };
    expect(await refused(STREAM_PATH, null)).toEqual({ status: 401, code: "AUTH_REQUIRED" });
    expect(await refused(STREAM_PATH, password)).toEqual({ status: 403, code: "MFA_REQUIRED" });
    // Past the second factor but before the starting data are chosen.
    expect(await refused(STREAM_PATH, cookie)).toEqual({ status: 403, code: "SETUP_DATA_REQUIRED" });
    await chooseEmpty();
    expect((await h.open(STREAM_PATH, { cookie: "openlife.session=forged" })).status).toBe(401);
    expect(h.hub.count(await sessionIdOf(h, cookie))).toBe(0);
  });
});

async function sessionIdOf(h: Awaited<ReturnType<typeof createAppHarness>>, cookie: string): Promise<string> {
  const token = await h.sessionToken(cookie);
  const row = h.rows<{ id: string }>(`SELECT id FROM session WHERE token = '${token}'`)[0];
  if (row === undefined) throw new Error("no session");
  return row.id;
}

describe("D37.1-AC2 how a stream ends and how many a session holds", () => {
  it("the sixth stream of a session is 429 with Retry-After and a closed one frees its place", async () => {
    const { h, cookie, chooseEmpty } = await ownerSession();
    await chooseEmpty();
    const streams = [];
    for (let each = 0; each < 5; each += 1) {
      const response = await h.open(STREAM_PATH, { cookie });
      expect(response.status).toBe(200);
      streams.push(readerOf(response));
      expect(await streams[each]!.next()).toEqual({ type: "ready" });
    }
    const sixth = await h.open(STREAM_PATH, { cookie });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe("5");
    expect(apiErrorSchema.parse(await sixth.json()).code).toBe("RATE_LIMITED");
    expect(h.hub.count(await sessionIdOf(h, cookie))).toBe(5);

    await streams[0]!.cancel();
    await expectEventually(async () => h.hub.count(await sessionIdOf(h, cookie)) === 4);
    const again = await h.open(STREAM_PATH, { cookie });
    expect(again.status).toBe(200);
    expect(await readerOf(again).next()).toEqual({ type: "ready" });
  });

  it("sign-out ends the streams of its session at once", async () => {
    const { h, cookie, chooseEmpty } = await ownerSession();
    await chooseEmpty();
    const first = readerOf(await h.open(STREAM_PATH, { cookie }));
    const second = readerOf(await h.open(STREAM_PATH, { cookie }));
    expect(await first.next()).toEqual({ type: "ready" });
    expect(await second.next()).toEqual({ type: "ready" });
    expect((await h.request("POST", SIGN_OUT_PATH, {}, { cookie })).status).toBe(204);
    expect(await first.next()).toBe("end");
    expect(await second.next()).toBe("end");
    expect((await h.open(STREAM_PATH, { cookie })).status).toBe(401);
  });

  it("a session that disappeared ends its stream at the next ping, whatever ended it", async () => {
    const { h, cookie, chooseEmpty } = await ownerSession({ pingIntervalMs: 60 });
    await chooseEmpty();
    const id = await sessionIdOf(h, cookie);
    const stream = readerOf(await h.open(STREAM_PATH, { cookie }));
    expect(await stream.next()).toEqual({ type: "ready" });
    h.sql(`DELETE FROM session WHERE id = '${id}'`);
    expect(await stream.next()).toBe("end");
    expect(h.hub.count(id)).toBe(0);
    expect(h.logLines().some((line) => line.includes('"event":"stream.closed"') && line.includes('"code":"AUTH_REQUIRED"'))).toBe(true);
  });

  it("a client that does not read is ended instead of buffered", async () => {
    const { h, cookie, chooseEmpty } = await ownerSession();
    await chooseEmpty();
    const id = await sessionIdOf(h, cookie);
    const response = await h.open(STREAM_PATH, { cookie });
    expect(h.hub.count(id)).toBe(1);
    for (let each = 0; each < 200; each += 1) h.hub.publish({ type: "data.changed", registry: `reg-${each}` });
    expect(h.hub.count(id)).toBe(0);
    await response.body!.cancel();
  });
});

describe("D37.1-AC2 the built server", () => {
  it("serves the stream to a signed-in owner, ends it at sign-out, and ends it when the server stops, which then exits cleanly", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const open = async () => {
      const controller = new AbortController();
      const response = await fetch(`${setup.server.baseUrl}${STREAM_PATH}`, { headers: { Cookie: owner.sessionCookie }, signal: controller.signal });
      return { response, stream: readerOf(response), controller };
    };
    const noCookie = await send(setup.server, "GET", STREAM_PATH, undefined);
    expect(noCookie.status).toBe(401);

    const kept = await open();
    expect(kept.response.status).toBe(200);
    expect(kept.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(await kept.stream.next()).toEqual({ type: "ready" });
    // The built server closes a stream with the session that opened it.
    expect((await send(setup.server, "POST", SIGN_OUT_PATH, {}, { cookie: owner.sessionCookie })).status).toBe(204);
    expect(await kept.stream.next()).toBe("end");
  });

  it("a stream that is open does not hold the stopping server: it ends and the process exits with 0", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const response = await fetch(`${setup.server.baseUrl}${STREAM_PATH}`, { headers: { Cookie: owner.sessionCookie } });
    const stream = readerOf(response);
    expect(await stream.next()).toEqual({ type: "ready" });
    const started = Date.now();
    setup.server.child.kill("SIGTERM");
    expect(await stream.next(5000)).toBe("end");
    const exit = await waitForExitOf(setup.server, 10_000);
    expect(exit.code, exit.output).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(exit.output).toContain('"event":"server.stopped"');
  });
});

async function expectEventually(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(await check()).toBe(true);
}
