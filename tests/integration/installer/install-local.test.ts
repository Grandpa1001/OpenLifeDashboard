// D19.1 — install.sh in local mode, the preflight and the installation folder, without Docker: a
// fake `docker` answers the preflight and accepts every stage, the real script writes a real folder,
// and a real server starts on the result. The container stages are install-stages.test.ts (D19.2);
// the real Docker run is D19.3.
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareComposeInstance } from "../../support/compose-instance.ts";
import { installerRig, runInstaller, startInstaller, type FakeDocker, type InstallerRig } from "../../support/installer-rig.ts";
import { repoRoot, startBuiltServer } from "../../support/server-process.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-install-sh-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const IMAGE = "openlife-app:test";
const OWNER_ARGS = ["--owner-email", "wlasciciel@example.com", "--owner-password-stdin"] as const;
const PASSWORD_LINE = "Zażółć gęślą jaźń 2026\n";
/** A run that goes through every stage, so it is given the owner's e-mail and password (stdin). */
const install = (rig: InstallerRig, args: readonly string[]) => runInstaller(rig, [...args, ...OWNER_ARGS], { input: PASSWORD_LINE });
let counter = 0;
const nextDir = (name = "installation"): string => path.join(root, `${name}-${(counter += 1)}`);

const envOf = (file: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

/** Every file of a folder with the hash of its content (the installer must change none of them on a rerun). */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return files;
}

const listing = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();

describe("D19.1-AC1 a clean folder becomes an installation that the server accepts", () => {
  const rig = installerRig();
  // Spaces and Polish letters in the path (Architektura §12.4 pt 9).
  const dir = path.join(root, "Mój Dashboard — ąęść", "instalacja 1");
  const first = install(rig, ["--dir", dir, "--port", "18321", "--image", IMAGE]);

  it("goes through the stages and records the last one", () => {
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain(`Installation folder: ${dir}`);
    expect(first.stdout).toContain("http://localhost:18321");
    expect(JSON.parse(readFileSync(path.join(dir, "control", "install-state.json"), "utf8"))).toMatchObject({ formatVersion: 1, stage: "complete" });
  });

  it("writes the same files and keys as the test preparer for Compose (D07.1)", () => {
    const reference = prepareComposeInstance(nextDir("reference"), { image: IMAGE, port: 18321 });
    const referenceFiles = listing(reference.dir).filter((name) => !name.endsWith("install-state.json"));
    expect(listing(dir).filter((name) => !name.endsWith("install-state.json"))).toEqual(referenceFiles);

    const env = envOf(path.join(dir, ".env"));
    const referenceEnv = envOf(reference.envFile);
    expect(Object.keys(env).sort()).toEqual(Object.keys(referenceEnv).sort());
    for (const key of ["INSTALL_MODE", "BASE_URL", "UPDATER_ENABLED", "PORT", "COMPOSE_PATH_SEPARATOR", "COMPOSE_FILE"]) {
      expect(env[key], key).toBe(referenceEnv[key]);
    }
    expect(env["BETTER_AUTH_SECRET"]).toMatch(/^[0-9a-f]{64}$/);
    expect(env["APP_ENCRYPTION_KEY"]).toMatch(/^[0-9a-f]{64}$/);
    expect(env["BETTER_AUTH_SECRET"]).not.toBe(env["APP_ENCRYPTION_KEY"]);
    expect(env["BETTER_AUTH_SECRET"]).not.toBe(referenceEnv["BETTER_AUTH_SECRET"]);
    expect(env["APP_UID"]).toBe(String(process.getuid?.()));
    expect(env["APP_GID"]).toBe(String(process.getgid?.()));

    const metadata = JSON.parse(readFileSync(path.join(dir, "control", "instance.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(Object.keys(JSON.parse(readFileSync(reference.instanceFile, "utf8")) as object).sort());
    expect(metadata).toMatchObject({ formatVersion: 1, installMode: "local", hostPlatform: "posix", installationPath: dir });
    expect(env["COMPOSE_PROJECT_NAME"]).toBe(metadata["composeProjectName"]);
    for (const file of ["compose.yml", "compose.local.yml"]) {
      expect(readFileSync(path.join(dir, file), "utf8")).toBe(readFileSync(path.join(repoRoot, "docker", file), "utf8"));
    }
    expect(readFileSync(path.join(dir, "control", "compose.release.yml"), "utf8")).toBe(`services:\n  app:\n    image: "${IMAGE}"\n`);
  });

  it("keeps .env, the data folder and the state for the owner only, and no secret outside .env", () => {
    if (process.platform === "win32") return;
    expect(statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "data")).mode & 0o777).toBe(0o700);
    const env = envOf(path.join(dir, ".env"));
    for (const [file, content] of Object.entries(snapshot(dir))) {
      if (file === ".env") continue;
      const text = readFileSync(path.join(dir, file), "utf8");
      expect(text, file).not.toContain(env["BETTER_AUTH_SECRET"]);
      expect(text, file).not.toContain(env["APP_ENCRYPTION_KEY"]);
      expect(content).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(first.stdout + first.stderr).not.toContain(env["BETTER_AUTH_SECRET"]);
    expect(first.stdout + first.stderr).not.toContain(env["APP_ENCRYPTION_KEY"]);
  });

  it("is an installation the server starts on", async () => {
    const env = envOf(path.join(dir, ".env"));
    const server = await startBuiltServer({
      installation: { dir, env: Object.fromEntries(["INSTALL_MODE", "BASE_URL", "BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "UPDATER_ENABLED"].map((key) => [key, env[key] ?? ""])) },
    });
    try {
      const health = await fetch(`${server.baseUrl}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      server.child.kill("SIGTERM");
      await new Promise((resolve) => server.child.once("exit", resolve));
    }
  });

  it("changes nothing on a second run", () => {
    const before = snapshot(dir);
    const second = install(rig, ["--dir", dir, "--image", IMAGE]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("nothing is overwritten");
    expect(snapshot(dir)).toEqual(before);
  });

  it("keeps the recorded port and refuses a different one", () => {
    const refused = install(rig, ["--dir", dir, "--image", IMAGE, "--port", "18999"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("already uses port 18321");
  });

  it("continues an interrupted folder with the same identity and keys, writing what is missing", () => {
    const partial = nextDir("partial");
    const done = install(rig, ["--dir", partial, "--port", "18322", "--image", IMAGE]);
    expect(done.status, done.stderr).toBe(0);
    const metadata = readFileSync(path.join(partial, "control", "instance.json"), "utf8");
    // The run stopped right after the identity file: state 'preparing', no .env, no compose files.
    writeFileSync(path.join(partial, "control", "install-state.json"), '{\n  "formatVersion": 1,\n  "stage": "preparing",\n  "updatedAt": "2026-01-01T00:00:00Z"\n}\n');
    for (const file of [".env", "compose.yml", "compose.local.yml", path.join("control", "compose.release.yml")]) rmSync(path.join(partial, file));

    const resumed = install(rig, ["--dir", partial, "--port", "18322", "--image", IMAGE]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(path.join(partial, "control", "instance.json"), "utf8")).toBe(metadata);
    expect(envOf(path.join(partial, ".env"))["COMPOSE_PROJECT_NAME"]).toBe((JSON.parse(metadata) as { composeProjectName: string }).composeProjectName);
    expect(JSON.parse(readFileSync(path.join(partial, "control", "install-state.json"), "utf8"))).toMatchObject({ stage: "complete" });
  });

  it("starts over in a folder that only holds folders (a first run stopped before its state)", () => {
    const empty = nextDir("folders-only");
    mkdirSync(path.join(empty, "data", "backup"), { recursive: true });
    mkdirSync(path.join(empty, "control"), { recursive: true });
    const run = install(rig, ["--dir", empty, "--port", "18323", "--image", IMAGE]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(empty, "control", "install-state.json"), "utf8"))).toMatchObject({ stage: "complete" });
  });

  it("never makes up the keys again when a folder past 'files' has lost its .env", () => {
    const damaged = nextDir("damaged");
    expect(install(rig, ["--dir", damaged, "--port", "18324", "--image", IMAGE]).status).toBe(0);
    rmSync(path.join(damaged, ".env"));
    const run = install(rig, ["--dir", damaged, "--port", "18324", "--image", IMAGE]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is missing; it is not recreated");
    expect(() => statSync(path.join(damaged, ".env"))).toThrow();
  });

  it("gives two installations different identities and keys", () => {
    const other = nextDir("second");
    expect(install(rig, ["--dir", other, "--port", "18325", "--image", IMAGE]).status).toBe(0);
    const identity = (folder: string) => ({
      env: envOf(path.join(folder, ".env")),
      metadata: JSON.parse(readFileSync(path.join(folder, "control", "instance.json"), "utf8")) as { instanceId: string },
    });
    const a = identity(dir);
    const b = identity(other);
    expect(a.metadata.instanceId).not.toBe(b.metadata.instanceId);
    expect(a.env["COMPOSE_PROJECT_NAME"]).not.toBe(b.env["COMPOSE_PROJECT_NAME"]);
    expect(a.env["BETTER_AUTH_SECRET"]).not.toBe(b.env["BETTER_AUTH_SECRET"]);
    expect(a.env["APP_ENCRYPTION_KEY"]).not.toBe(b.env["APP_ENCRYPTION_KEY"]);
  });
});

type Refusal = Readonly<{ name: string; docker?: FakeDocker | false; userId?: number; args?: readonly string[]; message: RegExp; status?: number }>;

describe("D19.1-AC2 a failed check ends with a clear message and writes nothing", () => {
  const refusals: Refusal[] = [
    { name: "no Docker CLI", docker: false, message: /Docker is not installed/ },
    { name: "the daemon is not running", docker: { daemonDown: true }, message: /daemon is not reachable.*Cannot connect/s },
    { name: "Windows containers", docker: { engineOs: "windows" }, message: /switch Docker to Linux containers/ },
    { name: "an old Engine", docker: { engineVersion: "24.0.7" }, message: /Docker Engine 24\.0\.7 is too old/ },
    { name: "an old Compose", docker: { composeVersion: "v2.23.3" }, message: /Compose v2\.23\.3 is too old/ },
    { name: "Compose version 1", docker: { composeVersion: "1.29.2" }, message: /Compose 1\.29\.2 is too old/ },
    { name: "no Compose plugin", docker: { composeMissing: true }, message: /Docker Compose .* is not available/ },
    { name: "running as root", userId: 0, message: /do not run the installer as root/ },
    { name: "a port below 1024", args: ["--port", "80"], message: /between 1024 and 65535/ },
    { name: "a port above 65535", args: ["--port", "70000"], message: /between 1024 and 65535/ },
    { name: "a port that is not a number", args: ["--port", "80a"], message: /must be a number/ },
    { name: "an image with a quote", args: ["--image", 'x"y'], message: /characters that are not allowed/ },
    { name: "an image with a space", args: ["--image", "a b"], message: /characters that are not allowed/ },
    { name: "the server mode", args: ["--mode", "server"], message: /'server' is not available yet/, status: 2 },
    { name: "an unknown argument", args: ["--frobnicate"], message: /unknown argument: --frobnicate/, status: 2 },
    { name: "an argument without a value", args: ["--port"], message: /--port needs a value/, status: 2 },
    { name: "a bad owner e-mail", args: ["--owner-email", "nie-adres"], message: /does not look like an address/ },
  ];

  for (const refusal of refusals) {
    it(`${refusal.name}: nonzero, a message, no folder`, () => {
      const dir = nextDir("refused");
      const rig = installerRig({ docker: refusal.docker ?? {}, ...(refusal.userId !== undefined ? { userId: refusal.userId } : {}) });
      const args = ["--dir", dir, "--port", "18330", "--image", IMAGE, ...(refusal.args ?? [])];
      // The last occurrence of an option wins, so the refusing option replaces the default one.
      const run = runInstaller(rig, args);
      expect(run.status, run.stdout).toBe(refusal.status ?? 1);
      expect(run.stderr).toMatch(refusal.message);
      expect(() => statSync(dir)).toThrow();
    });
  }

  it("a port that is in use", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const { port } = holder.address() as { port: number };
    try {
      const dir = nextDir("busy");
      const run = runInstaller(installerRig(), ["--dir", dir, "--port", String(port), "--image", IMAGE]);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`port ${port} is already in use`);
      expect(() => statSync(dir)).toThrow();
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it("a missing image", () => {
    const dir = nextDir("no-image");
    const run = runInstaller(installerRig(), ["--dir", dir, "--port", "18331"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--image is required");
    expect(() => statSync(dir)).toThrow();
  });

  it("a folder that holds somebody else's files, or a file instead of a folder", () => {
    const foreign = nextDir("foreign");
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, "notes.txt"), "mine");
    const before = snapshot(foreign);
    const refused = runInstaller(installerRig(), ["--dir", foreign, "--port", "18332", "--image", IMAGE]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/not an installation of this installer \(found .*notes\.txt\)/);
    expect(snapshot(foreign)).toEqual(before);

    const file = nextDir("a-file");
    writeFileSync(file, "x");
    const notFolder = runInstaller(installerRig(), ["--dir", file, "--port", "18332", "--image", IMAGE]);
    expect(notFolder.status).toBe(1);
    expect(notFolder.stderr).toContain("is not a folder");
  });

  it("another installation's folder without our state is not taken over", () => {
    const other = nextDir("test-instance");
    prepareComposeInstance(other, { image: IMAGE, port: 18333 });
    const before = snapshot(other);
    const run = runInstaller(installerRig(), ["--dir", other, "--port", "18333", "--image", IMAGE]);
    expect(run.status).toBe(1);
    expect(snapshot(other)).toEqual(before);
  });

  it("Ctrl+C while it waits for Docker ends it with 130 and creates nothing", async () => {
    const dir = nextDir("interrupted");
    const rig = installerRig({ docker: { hang: true } });
    const run = startInstaller(rig, ["--dir", dir, "--port", "18334", "--image", IMAGE]);
    await waitFor(() => existsSyncSafe(rig.startedMarker));
    run.interrupt();
    const { code, stderr } = await run.exit;
    expect(code).toBe(130);
    expect(stderr).toContain("run the installer again");
    expect(() => statSync(dir)).toThrow();
  });
});

function existsSyncSafe(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
