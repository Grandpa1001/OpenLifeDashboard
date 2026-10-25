// D07.1-AC2 (static part) — the compose files of docker/ say what the architecture requires,
// checked on the parsed YAML without Docker: only the app, the loopback publication, the three
// mounts of Architektura §15.1 with the right modes, no Docker socket, a non-root user, an
// explicit environment list, the healthcheck through Node and the 20 s grace period. The real
// Compose run of the same files is tests/system/compose-local.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "../../support/repository-copy.ts";

const load = (file: string): Record<string, unknown> => parse(readFileSync(path.join(repoRoot, "docker", file), "utf8")) as Record<string, unknown>;
const base = load("compose.yml");
const local = load("compose.local.yml");
const service = (document: Record<string, unknown>): Record<string, unknown> => {
  const services = document["services"] as Record<string, Record<string, unknown>>;
  expect(Object.keys(services)).toEqual(["app"]);
  return services["app"] ?? {};
};
const app = service(base);
const text = (value: unknown): string => JSON.stringify(value);

describe("D07.1-AC2 compose.yml (the app service)", () => {
  it("defines only the app: no Caddy, no updater, and no image (the release override pins it)", () => {
    expect(app).not.toHaveProperty("image");
    expect(app).not.toHaveProperty("build");
    expect(text(base)).not.toMatch(/caddy|UPDATER_TOKEN|RELEASES_REPO|DOMAIN|ACME/i);
    expect(Object.keys((base["services"] ?? {}) as object)).toEqual(["app"]);
  });

  it("mounts exactly data, instance.json read-only and the maintenance folder, none created by Docker", () => {
    const volumes = app["volumes"] as Array<Record<string, unknown>>;
    expect(volumes.map(({ source, target, read_only }) => ({ source, target, readOnly: read_only === true }))).toEqual([
      { source: "./data", target: "/data", readOnly: false },
      { source: "./control/instance.json", target: "/instance/instance.json", readOnly: true },
      { source: "./control/maintenance", target: "/control/maintenance", readOnly: false },
    ]);
    for (const volume of volumes) {
      expect(volume["type"]).toBe("bind");
      expect(volume["bind"]).toEqual({ create_host_path: false });
    }
    // The whole control folder, the installation folder and the Docker socket are never mounted.
    expect(text(volumes)).not.toMatch(/docker\.sock|"\.\/control"|"\.\/"|"\."|"\/"/);
  });

  it("runs as the host user, never root, read-only with every capability dropped", () => {
    expect(app["user"]).toBe("${APP_UID:-1000}:${APP_GID:-1000}");
    expect(app["read_only"]).toBe(true);
    expect(app["cap_drop"]).toEqual(["ALL"]);
    expect(app["security_opt"]).toEqual(["no-new-privileges:true"]);
    expect(app["tmpfs"]).toEqual(["/tmp:size=64m,mode=1777"]);
    for (const forbidden of ["privileged", "cap_add", "pid", "network_mode", "devices", "container_name", "env_file", "ports"]) {
      expect(app).not.toHaveProperty(forbidden);
    }
  });

  it("passes an explicit list of variables, secrets and URL required, optional options only when set", () => {
    const environment = app["environment"] as string[];
    const required = environment.filter((entry) => entry.includes(":?")).map((entry) => entry.split("=")[0]);
    expect(required).toEqual(["INSTALL_MODE", "BASE_URL", "BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY"]);
    const bare = environment.filter((entry) => !entry.includes("="));
    expect(bare).toEqual(["DB_BUSY_TIMEOUT_MS", "BACKUP_DISK_RESERVE_MIB", "IMPORT_MAX_MIB", "RECORD_MAX_KIB", "JSON_BODY_KIB"]);
    expect(environment).toContain("UPDATER_ENABLED=${UPDATER_ENABLED:-false}");
    expect(text(environment)).not.toMatch(/UPDATER_TOKEN|RELEASES_REPO/);
  });

  it("waits 20 s on stop, longer than the 15 s orderly shutdown", () => {
    expect(app["stop_grace_period"]).toBe("20s");
  });

  it("probes /api/health through the Node of the image and waits for a 200", () => {
    const healthcheck = app["healthcheck"] as { test: string[]; start_interval: string; start_period: string };
    expect(healthcheck.test.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
    // A string: unquoted, the "? 0 : 1" would have been parsed as a YAML mapping.
    expect(healthcheck.test[3]).toBeTypeOf("string");
    expect(healthcheck.test[3]).toContain("http://127.0.0.1:8080/api/health");
    expect(healthcheck.test[3]).toContain("r.ok ? 0 : 1");
    expect(healthcheck.test).toHaveLength(4);
    expect(healthcheck.start_interval).toBe("2s");
    expect(healthcheck.start_period).toBe("20s");
  });

  it("limits Docker's own log of the container", () => {
    expect(app["logging"]).toEqual({ driver: "local", options: { "max-size": "10m", "max-file": "3" } });
  });

  it("restarts unless stopped, so stopping the services keeps them stopped", () => {
    expect(app["restart"]).toBe("unless-stopped");
  });
});

describe("D07.1-AC1 compose.local.yml (the local mode)", () => {
  it("publishes only port 8080 of the container, only on the loopback address", () => {
    const ports = service(local)["ports"] as Array<Record<string, unknown>>;
    expect(ports).toEqual([{ target: 8080, published: "${PORT:-8080}", host_ip: "127.0.0.1", protocol: "tcp" }]);
    expect(Object.keys(service(local))).toEqual(["ports"]);
  });
});
