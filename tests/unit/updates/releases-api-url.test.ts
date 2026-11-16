// D53.3 — the base of the API of the releases is a setting of the installation (Architektura §11.1, §14.5): read only
// when the updater is on, HTTPS anywhere or HTTP on the loopback, never empty, never carrying credentials, a path or a
// query, and refused with the name of the key and never its value.
import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../../../apps/server/src/bootstrap/environment.js";

const KEY = "a".repeat(64);
const base = { INSTALL_MODE: "local", BASE_URL: "http://localhost:8080", BETTER_AUTH_SECRET: "b".repeat(64), APP_ENCRYPTION_KEY: "c".repeat(64), UPDATER_ENABLED: "true", UPDATER_TOKEN: KEY, RELEASES_REPO: "owner/name" };

describe("D53.3-AC2 RELEASES_API_URL", () => {
  it("is absent by default, and a valid one is kept for the client", () => {
    const absent = parseEnvironment(base);
    expect(absent.ok && absent.config.updater.enabled && absent.config.updater.releasesApiUrl).toBeUndefined();
    for (const good of ["https://ghe.example.com", "http://127.0.0.1:8081", "http://localhost:3000"]) {
      const result = parseEnvironment({ ...base, RELEASES_API_URL: good });
      expect(result.ok && result.config.updater.enabled && result.config.updater.releasesApiUrl, good).toBe(good.endsWith("/") ? good : good);
    }
  });

  it("is refused with its name and never its value when empty, plain HTTP off the loopback, with credentials, a path or a query", () => {
    for (const bad of ["", "http://api.example.com", "https://user:pw@api.example.com", "https://api.example.com/v3", "https://api.example.com?x=1", "ftp://127.0.0.1", "not a url"]) {
      const result = parseEnvironment({ ...base, RELEASES_API_URL: bad });
      expect(result, bad).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["RELEASES_API_URL"] });
    }
  });

  it("is not read when the updater is off, so a stale value of an installation without it breaks nothing", () => {
    const off = parseEnvironment({ ...base, UPDATER_ENABLED: "false", RELEASES_API_URL: "not a url" });
    expect(off.ok && off.config.updater.enabled).toBe(false);
  });
});
