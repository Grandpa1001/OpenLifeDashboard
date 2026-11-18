// D60.2-AC1/AC2 — the address of the client (Architektura §9.4, §14.4): the address of the connection, except from the one proxy that
// the installation trusts, whose X-Forwarded-For is the client. The name is resolved at the start and again for a stranger, never more
// often than every 10 s, and a name that does not answer keeps the addresses it had.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../../../apps/server/src/http/app-env.js";
import { createClientAddress, normalizeAddress, PROXY_RESOLVE_INTERVAL_MS } from "../../../apps/server/src/http/middleware/client-address.js";

function rig(options: { proxyHost?: string; addresses?: string[] } = {}) {
  const state = { now: 1_000_000, addresses: options.addresses ?? ["172.18.0.3"], lookups: 0, failing: false, peer: "172.18.0.3" };
  const events: string[] = [];
  const clientAddress = createClientAddress({
    ...(options.proxyHost === undefined ? {} : { proxyHost: options.proxyHost }),
    lookup: async () => {
      state.lookups += 1;
      if (state.failing) throw new Error("ENOTFOUND");
      return state.addresses;
    },
    nowMs: () => state.now,
    connectionAddress: () => state.peer,
    onResolved: (outcome) => events.push(outcome.ok ? `resolved ${outcome.addresses}` : "failed"),
  });
  const app = new Hono<AppEnv>();
  app.use("*", clientAddress.middleware);
  app.get("/", (c) => c.text(c.get("clientIp")));
  const ask = async (forwarded?: string): Promise<string> => (await app.request("/", forwarded === undefined ? {} : { headers: { "X-Forwarded-For": forwarded } })).text();
  return { state, events, clientAddress, ask };
}

describe("D60.2-AC1 whose X-Forwarded-For is believed", () => {
  it("the local mode (no proxy) ignores the header and never resolves a name", async () => {
    const { ask, state, clientAddress } = rig();
    await clientAddress.warm();
    expect(await ask("203.0.113.9")).toBe("172.18.0.3");
    expect(state.lookups).toBe(0);
  });

  it("the trusted proxy: the client is the address it wrote", async () => {
    const { ask, clientAddress } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    expect(await ask("203.0.113.9")).toBe("203.0.113.9");
    expect(await ask("2001:db8::7")).toBe("2001:db8::7");
  });

  it("the trusted proxy: a header from a client in front of it is not the last word, the entry of the proxy is", async () => {
    const { ask, clientAddress } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    expect(await ask("198.51.100.1, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("the trusted proxy without a header, or with one that is not an address, is the proxy itself", async () => {
    const { ask, clientAddress } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    expect(await ask()).toBe("172.18.0.3");
    expect(await ask("not-an-address")).toBe("172.18.0.3");
    expect(await ask("203.0.113.9, <script>")).toBe("172.18.0.3");
  });

  it("a peer that is not the proxy is believed in nothing it writes", async () => {
    const { ask, state, clientAddress } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    state.peer = "172.18.0.77";
    expect(await ask("203.0.113.9")).toBe("172.18.0.77");
  });

  it("the same address in two spellings is one address", async () => {
    expect(normalizeAddress("::ffff:172.18.0.3")).toBe("172.18.0.3");
    expect(normalizeAddress("2001:DB8::7")).toBe("2001:db8::7");
    const { ask, state, clientAddress } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    state.peer = "::ffff:172.18.0.3";
    expect(await ask("203.0.113.9")).toBe("203.0.113.9");
  });
});

describe("D60.2-AC1 the name is resolved at the start and again for a stranger, not too often", () => {
  it("a proxy that starts after the application is believed from its first request on", async () => {
    const { ask, state, clientAddress } = rig({ proxyHost: "caddy" });
    state.failing = true;
    await clientAddress.warm();
    expect(await ask("203.0.113.9")).toBe("172.18.0.3");
    state.failing = false;
    state.now += PROXY_RESOLVE_INTERVAL_MS;
    expect(await ask("203.0.113.9")).toBe("203.0.113.9");
  });

  it("a stranger makes the server resolve at most once in 10 s", async () => {
    const { ask, state, clientAddress } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    state.peer = "172.18.0.77";
    for (let index = 0; index < 50; index += 1) await ask("203.0.113.9");
    expect(state.lookups).toBe(1);
    state.now += PROXY_RESOLVE_INTERVAL_MS - 1;
    await ask();
    expect(state.lookups).toBe(1);
    state.now += 1;
    await ask();
    expect(state.lookups).toBe(2);
  });

  it("the address of the proxy changes (a restart of Caddy): the next request follows it", async () => {
    const { ask, state, clientAddress, events } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    state.addresses = ["172.18.0.9"];
    state.peer = "172.18.0.9";
    state.now += PROXY_RESOLVE_INTERVAL_MS;
    expect(await ask("203.0.113.9")).toBe("203.0.113.9");
    state.peer = "172.18.0.3";
    expect(await ask("203.0.113.8")).toBe("172.18.0.3");
    expect(events[0]).toBe("resolved 1");
  });

  it("a name that does not answer keeps the addresses it had", async () => {
    const { ask, state, clientAddress, events } = rig({ proxyHost: "caddy" });
    await clientAddress.warm();
    state.failing = true;
    expect(await ask("203.0.113.9")).toBe("203.0.113.9");
    state.peer = "172.18.0.77";
    state.now += PROXY_RESOLVE_INTERVAL_MS;
    expect(await ask("203.0.113.9")).toBe("172.18.0.77");
    expect(events).toEqual(["resolved 1", "failed"]);
    state.peer = "172.18.0.3";
    expect(await ask("203.0.113.9")).toBe("203.0.113.9");
  });

  it("parallel requests of a stranger share one resolution", async () => {
    const { ask, state, clientAddress } = rig({ proxyHost: "caddy" });
    state.failing = true;
    await clientAddress.warm();
    state.failing = false;
    state.now += PROXY_RESOLVE_INTERVAL_MS;
    state.lookups = 0;
    await Promise.all([ask("203.0.113.1"), ask("203.0.113.2"), ask("203.0.113.3")]);
    expect(state.lookups).toBe(1);
  });
});
