// D03.1-AC2 — random secret markers never appear in the config-check output (valid and invalid
// environments), in responses or logs of an isolated server, or in the built web assets and
// source maps. The asset scan fails on an empty file list.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PUBLIC_BOOTSTRAP_PATH, publicBootstrapSchema, DEFAULT_PUBLIC_BOOTSTRAP } from "@openlife/contracts/http/bootstrap";
import { afterAll, describe, expect, it } from "vitest";
import { EVIDENCE_DIR_ENV } from "../../../tooling/verification-tasks.ts";
import { generateSecret } from "../../support/bootstrap-cases.ts";
import { CONFIG_CHECK_ENTRY, repoRoot, runBuiltScript, startBuiltServer, waitForExit } from "../../support/server-process.ts";

const WEB_DIST = path.join(repoRoot, "apps/web/dist");
// Names of the private environment specification must not reach the SPA either (AR15).
const PRIVATE_ENV_NAMES = ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "UPDATER_TOKEN"];

const markers = { BETTER_AUTH_SECRET: generateSecret(), APP_ENCRYPTION_KEY: generateSecret(), UPDATER_TOKEN: generateSecret() };
const secretValues = Object.values(markers);
const baseEnv = { PATH: process.env["PATH"] ?? "/usr/bin", INSTALL_MODE: "local", BASE_URL: "http://localhost:18080", ...markers };
const scanned: string[] = [];

function expectNoSecrets(text: string, where: string): void {
  scanned.push(where);
  for (const secret of secretValues) {
    expect(text.includes(secret), `${where} must not contain a secret`).toBe(false);
  }
}

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => path.join(dir, String(entry)))
    .filter((file) => statSync(file).isFile());
}

afterAll(() => {
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, "secret-scan.json"), `${JSON.stringify({ markerCount: secretValues.length, scanned }, null, 2)}\n`);
  }
});

describe("D03.1-AC2 secret markers stay private", () => {
  it("control: the scan detects a leaked marker", () => {
    expect(() => expectNoSecrets(`token=${markers.UPDATER_TOKEN}`, "negative control")).toThrow();
  });

  it.each([
    ["valid environment", {}],
    ["invalid origin", { BASE_URL: "http://localhost:18080/sub" }],
    ["active updater without a repository", { UPDATER_ENABLED: "true" }],
    ["secrets that are not separate", { APP_ENCRYPTION_KEY: markers.BETTER_AUTH_SECRET }],
  ])("config-check output for a %s", async (label, patch) => {
    const run = await runBuiltScript(CONFIG_CHECK_ENTRY, [], { ...baseEnv, ...patch });
    expect(run.output.length).toBeGreaterThan(0);
    expectNoSecrets(run.output, `config-check stdout/stderr (${label})`);
  });

  it("an isolated server with the markers in its environment does not expose them", async () => {
    const server = await startBuiltServer({ env: baseEnv });
    try {
      for (const route of [PUBLIC_BOOTSTRAP_PATH, "/api/health", "/", "/api/unknown"]) {
        const response = await fetch(`${server.baseUrl}${route}`);
        const body = await response.text();
        expectNoSecrets(`${JSON.stringify([...response.headers])}\n${body}`, `HTTP ${route}`);
        if (route === PUBLIC_BOOTSTRAP_PATH) {
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(publicBootstrapSchema.parse(JSON.parse(body))).toEqual(DEFAULT_PUBLIC_BOOTSTRAP);
        }
      }
    } finally {
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, 15_000);
    }
    expectNoSecrets(server.output(), "server stdout/stderr");
  });

  it("built web assets and source maps contain no secrets or private env names", () => {
    const files = filesBelow(WEB_DIST);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith(".js"))).toBe(true);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      expectNoSecrets(content, path.relative(repoRoot, file));
      for (const name of PRIVATE_ENV_NAMES) {
        expect(content.includes(name), `${path.relative(repoRoot, file)} must not mention ${name}`).toBe(false);
      }
    }
  });
});
