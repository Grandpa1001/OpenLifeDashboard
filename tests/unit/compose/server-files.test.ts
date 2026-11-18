// D60.3-AC1/AC2 (static part) — docker/compose.server.yml and docker/Caddyfile say what Architektura §9.4, §12.1 and §15.1 require,
// checked on the parsed files without Docker: Caddy is the one service with published ports (80 and 443) and the only one in the
// edge network, the app is only in the internal network and publishes nothing, Caddy gets three values and not the .env, the image
// is pinned by a digest, the log is JSON without the headers of a secret and rotates by the defaults of the options of the log.
// The real run of the same files, with a real daemon, is tests/system/server-stack.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repoRoot } from "../../support/repository-copy.ts";

type Service = Record<string, unknown>;
const file = (name: string): string => readFileSync(path.join(repoRoot, "docker", name), "utf8");
const server = parse(file("compose.server.yml")) as { services: Record<string, Service>; networks: Record<string, unknown>; volumes: Record<string, unknown> };
const base = parse(file("compose.yml")) as { services: Record<string, Service> };
const caddyfile = file("Caddyfile");
const caddy = server.services["caddy"] ?? {};
const app = server.services["app"] ?? {};
const defaultOf = (key: string): number => {
  const definition = SETTINGS_CATALOG.find((each) => each.key === key);
  if (definition === undefined || definition.type !== "integer") throw new Error(`${key} is not an integer option`);
  return definition.defaultValue;
};

describe("D60.3-AC1 compose.server.yml: who is published and who is in which network", () => {
  it("adds exactly Caddy to the app, and the base file does not know Caddy", () => {
    expect(Object.keys(server.services).sort()).toEqual(["app", "caddy"]);
    expect(JSON.stringify(base)).not.toMatch(/caddy/i);
  });

  it("publishes 80 and 443 from Caddy and nothing from the app", () => {
    expect(app).not.toHaveProperty("ports");
    expect(caddy["ports"]).toEqual([
      { target: 80, published: 80, protocol: "tcp" },
      { target: 443, published: 443, protocol: "tcp" },
    ]);
  });

  it("puts only Caddy in the edge network and both in the internal one", () => {
    expect(Object.keys(server.networks).sort()).toEqual(["edge", "internal"]);
    expect(caddy["networks"]).toEqual(["edge", "internal"]);
    expect(app["networks"]).toEqual(["internal"]);
    expect(JSON.stringify(server.networks)).not.toContain("external");
  });

  it("tells the app the name of the one proxy it believes", () => {
    expect(app["environment"]).toEqual(["TRUSTED_PROXY_HOST=caddy"]);
  });

  it("gives Caddy the domain and the e-mail and nothing else of the environment, never the .env", () => {
    expect(caddy["environment"]).toEqual(["DOMAIN=${DOMAIN:?DOMAIN is set by the installer}", "ACME_EMAIL=${ACME_EMAIL:?ACME_EMAIL is set by the installer}"]);
    expect(caddy).not.toHaveProperty("env_file");
  });

  it("pins Caddy by a digest and starts it after a healthy app", () => {
    expect(caddy["image"]).toMatch(/^caddy:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/);
    expect(caddy["depends_on"]).toEqual({ app: { condition: "service_healthy" } });
  });

  it("is read-only with the capabilities it needs and no others, and mounts nothing of the installation but its file and its log", () => {
    expect(caddy["read_only"]).toBe(true);
    expect(caddy["cap_drop"]).toEqual(["ALL"]);
    expect(caddy["cap_add"]).toEqual(["NET_BIND_SERVICE", "DAC_OVERRIDE"]);
    expect(caddy["security_opt"]).toEqual(["no-new-privileges:true"]);
    for (const forbidden of ["privileged", "pid", "network_mode", "devices", "container_name"]) expect(caddy).not.toHaveProperty(forbidden);
    const volumes = caddy["volumes"] as Array<Record<string, unknown>>;
    expect(volumes.map(({ type, source, target, read_only }) => `${String(type)}:${String(source)}:${String(target)}:${read_only === true ? "ro" : "rw"}`)).toEqual([
      "bind:./Caddyfile:/etc/caddy/Caddyfile:ro",
      "bind:./data/logs/caddy:/var/log/caddy:rw",
      "volume:caddy_data:/data:rw",
      "volume:caddy_config:/config:rw",
    ]);
    expect(Object.keys(server.volumes).sort()).toEqual(["caddy_config", "caddy_data"]);
    expect(JSON.stringify(volumes)).not.toMatch(/docker\.sock|"\.\/"|"\."|"\/"|\.env/);
  });
});

describe("D60.3-AC1 the Caddyfile", () => {
  it("serves the domain from the environment, over ACME, with HSTS and the compression", () => {
    expect(caddyfile).toContain("{$DOMAIN} {");
    expect(caddyfile).toContain("email {$ACME_EMAIL}");
    expect(caddyfile).toMatch(/header Strict-Transport-Security "max-age=\d+"/);
    expect(caddyfile).toContain("encode zstd gzip");
    expect(caddyfile).not.toMatch(/tls internal|local_certs|acme_ca/);
  });

  it("proxies to the app on its port, replaces X-Forwarded-For and does not buffer the stream", () => {
    expect(caddyfile).toMatch(/reverse_proxy app:8080 \{[^}]*header_up X-Forwarded-For \{remote_host\}[^}]*flush_interval -1/s);
  });
});

describe("D60.3-AC2 the log of Caddy", () => {
  it("is JSON in the folder of Caddy, without Cookie, Authorization and Set-Cookie", () => {
    expect(caddyfile).toContain("output file /var/log/caddy/access.log");
    expect(caddyfile).toMatch(/format filter \{\s*wrap json/);
    for (const field of ["request>headers>Cookie delete", "request>headers>Authorization delete", "resp_headers>Set-Cookie delete"]) expect(caddyfile).toContain(field);
  });

  it("rotates by the defaults of the options of the log, the size and the number of files", () => {
    expect(caddyfile).toContain(`roll_size ${defaultOf("logs.fileMaxMiB")}MiB`);
    expect(caddyfile).toContain(`roll_keep ${defaultOf("logs.maxFiles")}`);
  });
});
