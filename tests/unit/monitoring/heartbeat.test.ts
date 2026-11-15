// D49.4 — the heartbeat of the nightly copy (Architektura §11.3.2).
// AC1: a configured address gets one GET without body, to the address the name resolved to, with the name for
//      the certificate and the Host header, and the answer 2xx is a success; nothing of the installation is in it.
// AC2: a bad configuration is refused at the start with the name of the key and never its value; an address that
//      is not HTTPS, holds credentials or is internal is refused, a name that resolves to an internal address
//      is refused before any connection, a redirect, a bad status, an error and a slow answer are failures with
//      a stable code, and no result carries the address.
import { describe, expect, it } from "vitest";
import { createHeartbeatSender, isInternalAddress, parseHeartbeatUrl, type HeartbeatRequest } from "../../../apps/server/src/adapters/monitoring/heartbeat.js";
import { parseEnvironment } from "../../../apps/server/src/bootstrap/environment.js";
import { Secret } from "../../../apps/server/src/bootstrap/secret.js";

const TOKEN = "tok3n-0123456789abcdef";
const URL_TEXT = `https://monitor.example.com/ping/${TOKEN}?from=backup`;
const PUBLIC = ["93.184.216.34"];

function sender(over: Partial<Parameters<typeof createHeartbeatSender>[0]> = {}) {
  const requests: HeartbeatRequest[] = [];
  const send = createHeartbeatSender({
    url: new Secret(URL_TEXT),
    resolve: async () => PUBLIC,
    transport: async (request) => (requests.push(request), 200),
    ...over,
  });
  return { send, requests };
}

describe("D49.4-AC1 one request to the monitor and nothing else", () => {
  it("sends a GET to the resolved address with the name kept for the certificate and the Host header", async () => {
    const { send, requests } = sender();
    expect(await send()).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ address: "93.184.216.34", hostname: "monitor.example.com", port: 443, host: "monitor.example.com", path: `/ping/${TOKEN}?from=backup` });
  });

  it("goes to a public address written as a literal without a lookup", async () => {
    const { send, requests } = sender({ url: new Secret("https://93.184.216.34:8443/x"), resolve: async () => { throw new Error("no lookup for a literal"); } });
    expect(await send()).toEqual({ ok: true });
    expect(requests[0]).toMatchObject({ address: "93.184.216.34", port: 8443, path: "/x" });
  });
});

describe("D49.4-AC2 the configuration and the failures", () => {
  it("refuses an address that is not HTTPS, holds credentials or a fragment, is too long or is an internal literal", () => {
    for (const bad of ["http://monitor.example.com/x", "ftp://monitor.example.com/x", "https://user:pw@monitor.example.com/x", "https://monitor.example.com/x#frag", "not a url", `https://monitor.example.com/${"a".repeat(2100)}`, "https://127.0.0.1/x", "https://10.1.2.3/x", "https://169.254.169.254/latest", "https://192.168.0.5/x", "https://[::1]/x", "https://[fd00::1]/x", "https://[::ffff:127.0.0.1]/x", "https://0.0.0.0/x"]) {
      expect(parseHeartbeatUrl(bad), bad).toBeUndefined();
    }
    expect(parseHeartbeatUrl(URL_TEXT)).toBeInstanceOf(URL);
  });

  it("knows the internal ranges and lets the public addresses through", () => {
    for (const internal of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.1.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "not an address"]) {
      expect(isInternalAddress(internal), internal).toBe(true);
    }
    for (const outside of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isInternalAddress(outside), outside).toBe(false);
    }
  });

  it("refuses a name that resolves to an internal address, also when only one of its addresses is internal, before any connection", async () => {
    for (const resolved of [["127.0.0.1"], ["10.0.0.7"], ["93.184.216.34", "192.168.1.9"], ["::1"]]) {
      const { send, requests } = sender({ resolve: async () => resolved });
      expect(await send()).toEqual({ ok: false, code: "HEARTBEAT_ADDRESS_FORBIDDEN" });
      expect(requests).toEqual([]);
    }
  });

  it("answers unreachable for a name with no address and failed for a transport error", async () => {
    expect(await sender({ resolve: async () => [] }).send()).toEqual({ ok: false, code: "HEARTBEAT_UNREACHABLE" });
    expect(await sender({ resolve: async () => { throw new Error("ENOTFOUND"); } }).send()).toEqual({ ok: false, code: "HEARTBEAT_FAILED" });
    expect(await sender({ transport: async () => { throw new Error("ECONNRESET"); } }).send()).toEqual({ ok: false, code: "HEARTBEAT_FAILED" });
  });

  it("treats a redirect as a failure and does not follow it, and a status outside 2xx as a bad status", async () => {
    for (const status of [301, 302, 307]) {
      const { send, requests } = sender({ transport: async (request) => (requests.push(request), status) });
      expect(await send()).toEqual({ ok: false, code: "HEARTBEAT_REDIRECT" });
      expect(requests).toHaveLength(1);
    }
    for (const status of [199, 404, 500]) expect(await sender({ transport: async () => status }).send()).toEqual({ ok: false, code: "HEARTBEAT_BAD_STATUS" });
  });

  it("ends a slow answer and a slow name resolution at the timeout", async () => {
    expect(await sender({ timeoutMs: 30, transport: () => new Promise<number>(() => undefined) }).send()).toEqual({ ok: false, code: "HEARTBEAT_TIMEOUT" });
    expect(await sender({ timeoutMs: 30, resolve: () => new Promise<readonly string[]>(() => undefined) }).send()).toEqual({ ok: false, code: "HEARTBEAT_TIMEOUT" });
  });

  it("carries the address in no result", async () => {
    const results = [await sender({ transport: async () => 500 }).send(), await sender({ resolve: async () => ["127.0.0.1"] }).send(), await sender({ transport: async () => { throw new Error(URL_TEXT); } }).send()];
    for (const result of results) expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("D49.4-AC2 the address in the environment", () => {
  const base = { INSTALL_MODE: "local", BASE_URL: "http://localhost:8080", BETTER_AUTH_SECRET: "a".repeat(64), APP_ENCRYPTION_KEY: "b".repeat(64) };

  it("is optional, and a valid address is kept as a secret", () => {
    const absent = parseEnvironment(base);
    expect(absent.ok && absent.config.backupHeartbeatUrl).toBe(undefined);
    const set = parseEnvironment({ ...base, BACKUP_HEARTBEAT_URL: URL_TEXT });
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.config.backupHeartbeatUrl?.reveal()).toBe(URL_TEXT);
      expect(JSON.stringify(set.config)).not.toContain(TOKEN);
    }
  });

  it("refuses an empty, a plain HTTP and an internal address with the name of the key and never its value", () => {
    for (const bad of ["", "http://monitor.example.com/ping/" + TOKEN, `https://127.0.0.1/${TOKEN}`, `https://user:${TOKEN}@monitor.example.com/x`]) {
      const result = parseEnvironment({ ...base, BACKUP_HEARTBEAT_URL: bad });
      expect(result).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["BACKUP_HEARTBEAT_URL"] });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });
});
