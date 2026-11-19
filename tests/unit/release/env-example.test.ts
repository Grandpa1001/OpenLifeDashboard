// D61.2-AC1 — `.env.example` documents exactly the keys of the .env of an installation: those the installers write, those the Compose files read from
// it and those the updater and the options take from it; the secrets are empty and no value that looks like a key is in it. The keys are taken from the
// files themselves, so a key added to the installer or to a Compose file and not documented here fails this test.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { installerRig, runInstaller } from "../../support/installer-rig.ts";
import { repoRoot } from "../../support/repository-copy.ts";
import { scratchDir } from "../../support/scratch.ts";

const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
/** `KEY=value` and the commented `# KEY=value` lines; a comment that is prose has a space or no equals sign right after the key. */
const documented = new Map<string, string>();
for (const line of example.split("\n")) {
  const match = /^(?:# )?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match?.[1] !== undefined) documented.set(match[1], match[2] ?? "");
}
const SECRETS = ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "UPDATER_TOKEN"];

/** The variables of the .env that the Compose files read: `${NAME...}` anywhere, and a plain `- NAME` of an environment list. */
function composeKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(path.join(repoRoot, "docker")).filter((name) => /^compose.*\.yml$/.test(name))) {
    const text = readFileSync(path.join(repoRoot, "docker", file), "utf8");
    for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) if (match[1] !== undefined) keys.add(match[1]);
    const document = parse(text) as { services: Record<string, { environment?: string[] }> };
    for (const service of Object.values(document.services)) for (const entry of service.environment ?? []) if (!entry.includes("=")) keys.add(entry);
  }
  return keys;
}

/** The keys the installer writes, taken from a real run of it in each mode against a fake Docker. */
function installerKeys(): Set<string> {
  const keys = new Set<string>();
  const run = (mode: "local" | "server"): void => {
    const rig = installerRig({ system: { os: "Linux", dns: {} } });
    const dir = path.join(scratchDir("openlife-env-example-"), "installation");
    const args = mode === "local" ? ["--dir", dir, "--port", "18999", "--image", "openlife-app:test", "--yes", "--owner-email", "a@example.com", "--owner-password-stdin"] : ["--mode", "server", "--dir", dir, "--domain", "dziennik.example.com", "--acme-email", "a@example.com", "--image", "openlife-app:test", "--yes"];
    const result = runInstaller(rig, args, { input: "Zażółć gęślą jaźń 2026\n" });
    expect([0, 3], `${result.stdout}${result.stderr}`).toContain(result.status);
    for (const line of readFileSync(path.join(dir, ".env"), "utf8").split("\n")) {
      const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      if (key !== undefined) keys.add(key);
    }
  };
  run("local");
  run("server");
  return keys;
}

describe("D61.2-AC1 .env.example documents the keys of an installation", () => {
  it("has exactly the keys that the installers write, the Compose files read and the updater takes", () => {
    const expected = new Set([...installerKeys(), ...composeKeys()]);
    expect([...documented.keys()].sort()).toEqual([...expected].sort());
  });

  it("leaves the secrets empty and holds no value that looks like a key or a token", () => {
    for (const secret of SECRETS) expect(documented.get(secret), secret).toBe("");
    expect(example).not.toMatch(/[0-9a-f]{64}/i);
    expect(example).not.toMatch(/ghp_|github_pat_|sk-[A-Za-z0-9]{10}/);
  });

  it("shows the value of every key written by the installer in the shape the application accepts", () => {
    expect(documented.get("INSTALL_MODE")).toBe("local");
    expect(documented.get("BASE_URL")).toMatch(/^http:\/\/localhost:\d+$/);
    expect(documented.get("COMPOSE_FILE")).toBe("compose.yml;compose.local.yml;control/compose.release.yml");
    expect(documented.get("COMPOSE_PATH_SEPARATOR")).toBe(";");
    expect(documented.get("COMPOSE_PROJECT_NAME")).toMatch(/^openlife-[0-9a-f]{12}$/);
    expect(documented.get("UPDATER_ENABLED")).toBe("false");
  });
});
