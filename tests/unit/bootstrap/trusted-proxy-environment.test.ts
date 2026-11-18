// D60.2-AC1 — TRUSTED_PROXY_HOST in the parser of the environment (Architektura §14.5): only the server mode has a proxy to trust,
// and the value is the name of a service, never an address, a port, a path or a list. A wrong value is CONFIG_INVALID with the name of the field.
import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../../../apps/server/src/bootstrap/environment.js";

const KEYS = { BETTER_AUTH_SECRET: "a".repeat(64), APP_ENCRYPTION_KEY: "b".repeat(64) };
const server = { INSTALL_MODE: "server", BASE_URL: "https://dashboard.example.invalid", ...KEYS };
const local = { INSTALL_MODE: "local", BASE_URL: "http://localhost:8080", ...KEYS };

describe("D60.2-AC1 TRUSTED_PROXY_HOST", () => {
  it("is absent by default in both modes", () => {
    for (const env of [server, local]) {
      const result = parseEnvironment(env);
      expect(result.ok && result.config.trustedProxyHost).toBeFalsy();
    }
  });

  it.each(["caddy", "caddy-1", "proxy.internal", "a"])("the server mode accepts the service name %s", (host) => {
    const result = parseEnvironment({ ...server, TRUSTED_PROXY_HOST: host });
    expect(result.ok && result.config.trustedProxyHost).toBe(host);
  });

  it("the local mode refuses it: there is no proxy there", () => {
    expect(parseEnvironment({ ...local, TRUSTED_PROXY_HOST: "caddy" })).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["TRUSTED_PROXY_HOST"] });
  });

  it.each(["", "10.0.0.5", "::1", "[::1]", "Caddy", "caddy:80", "caddy/x", "caddy,other", "caddy other", "-caddy", "caddy-", "a..b", `${"a".repeat(64)}`, "*", "0.0.0.0/0"])("refuses %j", (host) => {
    expect(parseEnvironment({ ...server, TRUSTED_PROXY_HOST: host })).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["TRUSTED_PROXY_HOST"] });
  });

  it("names the field and never the value", () => {
    const result = parseEnvironment({ ...server, TRUSTED_PROXY_HOST: "10.9.8.7" });
    expect(JSON.stringify(result)).not.toContain("10.9.8.7");
  });
});
