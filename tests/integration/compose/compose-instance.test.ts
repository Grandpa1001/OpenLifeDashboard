// D07.1 — the test installation for Compose, without Docker: the files, the keys of .env and the
// rules of the preparer (a fresh folder only, keys never printed). The real Compose run of the
// result is tests/system/compose-local.ts.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareComposeInstance, COMPOSE_FILES } from "../../support/compose-instance.ts";
import { NotFreshDirectoryError } from "../../support/test-instance.ts";
import { repoRoot, runBuiltScript } from "../../support/server-process.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-compose-instance-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const envOf = (file: string): Record<string, string> =>
  Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

describe("D07.1 the preparer for Compose", () => {
  const dir = path.join(root, "OpenLife Compose Test");
  const instance = prepareComposeInstance(dir, { image: "openlife-app:test", port: 18080, uid: 1234, gid: 4321 });
  const env = envOf(instance.envFile);

  it("copies the compose files of docker/ and writes the release override last in COMPOSE_FILE", () => {
    for (const file of ["compose.yml", "compose.local.yml"]) {
      expect(readFileSync(path.join(dir, file), "utf8")).toBe(readFileSync(path.join(repoRoot, "docker", file), "utf8"));
    }
    expect(readFileSync(path.join(dir, "control", "compose.release.yml"), "utf8")).toBe('services:\n  app:\n    image: "openlife-app:test"\n');
    expect(env["COMPOSE_PATH_SEPARATOR"]).toBe(";");
    expect(env["COMPOSE_FILE"]).toBe("compose.yml;compose.local.yml;control/compose.release.yml".split("/").join(path.sep));
    expect(COMPOSE_FILES.at(-1)).toBe(path.join("control", "compose.release.yml"));
  });

  it("writes the installation keys: port, base URL of that port, host user and the project of instance.json", () => {
    const metadata = JSON.parse(readFileSync(instance.instanceFile, "utf8")) as { composeProjectName: string };
    expect(env["PORT"]).toBe("18080");
    expect(env["BASE_URL"]).toBe("http://localhost:18080");
    expect(env["APP_UID"]).toBe("1234");
    expect(env["APP_GID"]).toBe("4321");
    expect(env["COMPOSE_PROJECT_NAME"]).toBe(metadata.composeProjectName);
    expect(env["COMPOSE_PROJECT_NAME"]).toMatch(/^openlife-[0-9a-f]{12}$/);
    expect(env["INSTALL_MODE"]).toBe("local");
    expect(env["UPDATER_ENABLED"]).toBe("false");
    expect(env["UPDATER_TOKEN"]).toBeUndefined();
  });

  it("creates the folders of the mounts and keeps .env readable by its owner only", () => {
    expect(readdirSync(path.join(dir, "data")).sort()).toEqual(["backup", "logs", "tmp"]);
    expect(readdirSync(path.join(dir, "control")).sort()).toEqual(["compose.release.yml", "instance.json", "maintenance"]);
    if (process.platform !== "win32") expect(statSync(instance.envFile).mode & 0o777).toBe(0o600);
    // No secret is part of any file Compose reads besides .env.
    for (const file of ["compose.yml", "compose.local.yml", path.join("control", "compose.release.yml")]) {
      for (const secret of instance.secrets) expect(readFileSync(path.join(dir, file), "utf8").includes(secret)).toBe(false);
    }
  });

  it("refuses a folder that is not empty, like the plain preparer", () => {
    expect(() => prepareComposeInstance(dir, { image: "openlife-app:test", port: 18081 })).toThrow(NotFreshDirectoryError);
    expect(envOf(instance.envFile)["PORT"]).toBe("18080");
  });

  it("the command line prepares the same folder, prints the start command and no key", async () => {
    const target = path.join(root, "from-cli");
    const run = await runBuiltScript(path.join(repoRoot, "scripts/prepare-test-instance.ts"), [target, "--image", "openlife-app:cli", "--port", "18082"], { PATH: process.env["PATH"] ?? "" });
    expect(run.code).toBe(0);
    expect(run.output).toContain("docker compose up --detach --wait");
    const cliEnv = envOf(path.join(target, ".env"));
    expect(cliEnv["PORT"]).toBe("18082");
    for (const key of ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY"]) expect(run.output.includes(cliEnv[key] ?? "missing")).toBe(false);
  });

  it.each([
    [["--image", "x", "--mode", "server"]],
    [["--image", "x", "--base-url", "https://example.invalid"]],
    [["--image", "x", "--port", "70000"]],
  ])("the command line refuses %j and creates nothing", async (flags) => {
    const target = path.join(root, `refused-${flags.join("-").replace(/[^a-z0-9-]/gi, "")}`);
    const run = await runBuiltScript(path.join(repoRoot, "scripts/prepare-test-instance.ts"), [target, ...flags], { PATH: process.env["PATH"] ?? "" });
    expect(run.code).toBe(1);
    expect(run.output).toContain("usage:");
    expect(() => readdirSync(target)).toThrow();
  });
});
