// D58.3 — an interrupted installation continues in both modes, against a fake Docker: Ctrl+C or a
// failure at every stage keeps the keys, the identity of the folder, the account and the image of
// the installation; a newer package next to it changes nothing; errors of the environment (no
// network, no Docker, an old Compose, a taken port, a path with spaces) end with a message and a
// state that the next run continues from. A real Linux is D58.4.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildReleasePackage } from "../../../scripts/support/release-package.ts";
import { dockerCalls, installerRig, runInstaller, startInstaller, type FakeDocker, type InstallerRig } from "../../support/installer-rig.ts";
import { repoRoot } from "../../support/server-process.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-install-resume-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const IMAGE_OLD = `registry.example.test/openlife/app@sha256:${"a".repeat(64)}`;
const IMAGE_NEW = `registry.example.test/openlife/app@sha256:${"b".repeat(64)}`;
const OWNER_ARGS = ["--owner-email", "wlasciciel@example.com", "--owner-password-stdin"] as const;
const PASSWORD_LINE = "Zażółć gęślą jaźń 2026\n";
const DOMAIN = "dziennik.example.com";
const SERVER_ARGS = ["--mode", "server", "--domain", DOMAIN, "--acme-email", "admin@example.com"] as const;
/** A Linux whose DNS does not know the domain yet: the server installation stops after its files, the state these tests continue (D60.4 moved the rest of the server mode to install-server-stack.test.ts). */
const LINUX = { os: "Linux", dns: {} } as const;

const older = buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(root, "older"), version: "1.4.0", image: IMAGE_OLD });
const newer = buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(root, "newer"), version: "1.5.0", image: IMAGE_NEW });

let counter = 0;
const nextDir = (name = "Instalacja"): string => path.join(root, `${name} ${(counter += 1)}`);
const scriptOf = (pack: { folder: string }): string => path.join(pack.folder, "install.sh");

const localArgs = (dir: string, port: number, extra: readonly string[] = []): string[] => ["--dir", dir, "--port", String(port), "--yes", ...extra];
const withOwner = (pack: { folder: string }, rig: InstallerRig, dir: string, port = 18600) =>
  runInstaller(rig, localArgs(dir, port, OWNER_ARGS), { script: scriptOf(pack), input: PASSWORD_LINE });
/** A run that is given neither the e-mail nor the password: right for an installation past its owner stage. */
const plain = (pack: { folder: string }, rig: InstallerRig, dir: string, extra: readonly string[] = []) =>
  runInstaller(rig, ["--dir", dir, "--yes", ...extra], { script: scriptOf(pack) });

const stageOf = (dir: string): string => (JSON.parse(readFileSync(path.join(dir, "control", "install-state.json"), "utf8")) as { stage: string }).stage;
const identity = (dir: string): Record<string, string> =>
  Object.fromEntries([".env", "control/instance.json", "control/compose.release.yml"].map((file) => [file, readFileSync(path.join(dir, file), "utf8")]));
const steps = (rig: InstallerRig): string[] => dockerCalls(rig).map((line) => line.slice(line.indexOf(" :: ") + 4));
const ownerRuns = (rig: InstallerRig): number => steps(rig).filter((call) => call.startsWith("compose run")).length;

/** Starts the installer of a package, waits until the fake Docker blocks, and sends Ctrl+C. */
async function interruptedRun(pack: { folder: string }, rig: InstallerRig, dir: string): Promise<void> {
  const started = startInstaller(rig, localArgs(dir, 18600, OWNER_ARGS), PASSWORD_LINE, scriptOf(pack));
  const deadline = Date.now() + 15_000;
  while (!existsSync(rig.blockedMarker)) {
    if (Date.now() > deadline) throw new Error("the installer never reached the blocking call");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  started.interrupt();
  expect((await started.exit).code).toBe(130);
}

type Interruption = Readonly<{ name: string; docker: FakeDocker; stage: string; ownerAfterRerun: number }>;
const INTERRUPTIONS: readonly Interruption[] = [
  { name: "while the image is downloaded", docker: { imageMissing: true, pullHangs: true }, stage: "files", ownerAfterRerun: 1 },
  { name: "while the application starts", docker: { upHangsOnCall: 1 }, stage: "images", ownerAfterRerun: 1 },
  { name: "while the owner account is created", docker: { ownerHangs: true }, stage: "started", ownerAfterRerun: 1 },
  { name: "while the application starts again", docker: { upHangsOnCall: 2 }, stage: "owner", ownerAfterRerun: 0 },
];

describe("D58.3-AC1 a run that is continued keeps the keys, the account and the version", () => {
  for (const interruption of INTERRUPTIONS) {
    it(`Ctrl+C ${interruption.name}: the stage is '${interruption.stage}', the rerun finishes and the identity is the same`, async () => {
      const dir = nextDir();
      await interruptedRun(older, installerRig({ docker: interruption.docker }), dir);
      expect(stageOf(dir)).toBe(interruption.stage);
      const before = identity(dir);

      const rig = installerRig();
      const finished = interruption.stage === "owner" ? plain(older, rig, dir) : withOwner(older, rig, dir);
      expect(finished.status, finished.stderr).toBe(0);
      expect(stageOf(dir)).toBe("complete");
      expect(identity(dir)).toEqual(before);
      expect(before["control/compose.release.yml"]).toContain(IMAGE_OLD);
      expect(ownerRuns(rig)).toBe(interruption.ownerAfterRerun);
    });
  }

  it("a complete installation run again from the installer is not changed and starts nothing", () => {
    const dir = nextDir();
    expect(withOwner(older, installerRig(), dir).status).toBe(0);
    const before = identity(dir);
    const rig = installerRig();
    const again = plain(older, rig, dir);
    expect(again.status, again.stderr).toBe(0);
    expect(identity(dir)).toEqual(before);
    expect(steps(rig).filter((call) => /^compose (up|run|stop)/.test(call))).toEqual([]);
  });

  describe("a newer package next to an installation that is begun", () => {
    it("a complete installation stays at its version and the run points to the Updates page", () => {
      const dir = nextDir();
      expect(withOwner(older, installerRig(), dir).status).toBe(0);
      const before = identity(dir);
      const rig = installerRig();
      const run = plain(newer, rig, dir);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(IMAGE_OLD);
      expect(run.stdout).toContain("release package 1.5.0");
      expect(run.stdout).toContain("Updates page");
      expect(identity(dir)).toEqual(before);
      expect(stageOf(dir)).toBe("complete");
      expect(dockerCalls(rig).join("\n")).not.toContain(IMAGE_NEW);
    });

    it("an interrupted installation is finished with its own image, not with the one of the newer package", () => {
      const dir = nextDir();
      const failing = installerRig({ docker: { upFailsOnCalls: [1] } });
      expect(withOwner(older, failing, dir).status).toBe(1);
      expect(stageOf(dir)).toBe("images");
      const before = identity(dir);

      const rig = installerRig();
      const finished = withOwner(newer, rig, dir);
      expect(finished.status, finished.stderr).toBe(0);
      expect(finished.stdout).toContain("Updates page");
      expect(stageOf(dir)).toBe("complete");
      expect(identity(dir)).toEqual(before);
      expect(dockerCalls(rig).join("\n")).not.toContain(IMAGE_NEW);
      expect(ownerRuns(rig)).toBe(1);
    });

    it("an image given by hand that differs from the installed one is not installed either", () => {
      const dir = nextDir();
      expect(runInstaller(installerRig(), [...localArgs(dir, 18600, OWNER_ARGS), "--image", "openlife-app:one"], { input: PASSWORD_LINE }).status).toBe(0);
      const before = identity(dir);
      const rig = installerRig();
      const run = runInstaller(rig, ["--dir", dir, "--yes", "--image", "openlife-app:two"]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("openlife-app:two is not installed here");
      expect(identity(dir)).toEqual(before);
      expect(dockerCalls(rig).join("\n")).not.toContain("openlife-app:two");
    });

    it("a server installation keeps its image and keys when a newer package is run with the same domain", () => {
      const dir = nextDir();
      const first = runInstaller(installerRig({ system: LINUX }), ["--dir", dir, "--yes", ...SERVER_ARGS], { script: scriptOf(older) });
      expect(first.status, first.stderr).toBe(3);
      const before = identity(dir);
      const rig = installerRig({ system: LINUX });
      const run = runInstaller(rig, ["--dir", dir, "--yes", ...SERVER_ARGS], { script: scriptOf(newer) });
      expect(run.status, run.stderr).toBe(3);
      expect(run.stdout).toContain("Updates page");
      expect(identity(dir)).toEqual(before);
      expect(dockerCalls(rig)).toEqual([]);
    });
  });

  it("a server installation run again keeps its keys and its domain, and still says that nothing is installed", () => {
    const dir = nextDir();
    expect(runInstaller(installerRig({ system: LINUX }), ["--dir", dir, "--yes", ...SERVER_ARGS], { script: scriptOf(older) }).status).toBe(3);
    const before = identity(dir);
    const again = runInstaller(installerRig({ system: LINUX }), ["--dir", dir, "--yes", "--mode", "server"], { script: scriptOf(older) });
    expect(again.status, again.stderr).toBe(3);
    expect(again.stdout).toContain("NOT installed");
    expect(identity(dir)).toEqual(before);
  });

  it("an installation stopped before its keys were written is made again from its own identity file", () => {
    const dir = nextDir();
    expect(runInstaller(installerRig({ system: LINUX }), ["--dir", dir, "--yes", ...SERVER_ARGS], { script: scriptOf(older) }).status).toBe(3);
    const instance = readFileSync(path.join(dir, "control", "instance.json"), "utf8");
    // As if the run had stopped right after the identity file: no keys, no Compose files, the stage still 'preparing'.
    for (const file of [".env", "compose.yml", "control/compose.release.yml"]) rmSync(path.join(dir, file));
    writeFileSync(path.join(dir, "control", "install-state.json"), '{\n  "formatVersion": 1,\n  "stage": "preparing",\n  "updatedAt": "2026-11-17T00:00:00Z"\n}\n');
    const again = runInstaller(installerRig({ system: LINUX }), ["--dir", dir, "--yes", ...SERVER_ARGS], { script: scriptOf(older) });
    expect(again.status, again.stderr).toBe(3);
    expect(readFileSync(path.join(dir, "control", "instance.json"), "utf8")).toBe(instance);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toContain(`DOMAIN=${DOMAIN}`);
    expect(stageOf(dir)).toBe("files");
  });
});

/** A free port of the loopback address, and a way to hold it. */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((resolve) => probe.listen(0, "127.0.0.1", () => resolve((probe.address() as { port: number }).port)));
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const hold = (port: number): Promise<Server> =>
  new Promise((resolve) => {
    const holder = createServer();
    holder.listen(port, "127.0.0.1", () => resolve(holder));
  });

describe("D58.3-AC2 an error of the environment ends with a message and a state that the next run continues from", () => {
  /** Fails the first run at the stage 'images' (the application does not become healthy), so there is a stage to continue from. */
  function failedAtImages(dir: string, port = 18600): void {
    const failing = installerRig({ docker: { upFailsOnCalls: [1] } });
    expect(withOwner(older, failing, dir, port).status).toBe(1);
    expect(stageOf(dir)).toBe("images");
  }

  const environments: ReadonlyArray<Readonly<{ name: string; docker: FakeDocker; message: RegExp }>> = [
    { name: "Docker is not running", docker: { daemonDown: true }, message: /Docker daemon is not reachable/ },
    { name: "Docker Compose is too old", docker: { composeVersion: "v2.10.0" }, message: /Docker Compose v?2\.10\.0 is too old/ },
    { name: "Docker Compose is missing", docker: { composeMissing: true }, message: /Docker Compose .* is not available/ },
  ];
  for (const environment of environments) {
    it(`${environment.name}: nothing changes and the next run finishes`, () => {
      const dir = nextDir();
      failedAtImages(dir);
      const before = identity(dir);
      const rig = installerRig({ docker: environment.docker });
      const refused = withOwner(older, rig, dir);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(environment.message);
      expect(stageOf(dir)).toBe("images");
      expect(identity(dir)).toEqual(before);
      expect(steps(rig).filter((call) => /^compose (up|run|stop)/.test(call))).toEqual([]);

      const finished = withOwner(older, installerRig(), dir);
      expect(finished.status, finished.stderr).toBe(0);
      expect(stageOf(dir)).toBe("complete");
      expect(identity(dir)).toEqual(before);
    });
  }

  it("a port taken meanwhile: the run says so before it starts anything, and finishes once the port is free", async () => {
    const dir = nextDir();
    const port = await freePort();
    failedAtImages(dir, port);
    const before = identity(dir);
    const holder = await hold(port);
    try {
      const rig = installerRig();
      const refused = withOwner(older, rig, dir, port);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`port ${port} is already in use`);
      expect(stageOf(dir)).toBe("images");
      expect(identity(dir)).toEqual(before);
      expect(steps(rig).filter((call) => /^compose (up|run|stop)/.test(call))).toEqual([]);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
    const finished = withOwner(older, installerRig(), dir, port);
    expect(finished.status, finished.stderr).toBe(0);
    expect(stageOf(dir)).toBe("complete");
  });

  it("no network for the image: the stage stays 'files', the message names what to do, the next run pulls again", () => {
    const dir = nextDir();
    const offline = installerRig({ docker: { imageMissing: true, pullFails: true } });
    const refused = withOwner(older, offline, dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/could not be pulled \(no internet/);
    expect(refused.stderr).toContain("run the installer again");
    expect(stageOf(dir)).toBe("files");
    const before = identity(dir);

    const online = installerRig({ docker: { imageMissing: true } });
    const finished = withOwner(older, online, dir);
    expect(finished.status, finished.stderr).toBe(0);
    expect(steps(online)).toContain(`pull ${IMAGE_OLD}`);
    expect(identity(dir)).toEqual(before);
  });

  it("a folder whose keys are gone is refused and not made again", () => {
    const dir = nextDir();
    failedAtImages(dir);
    rmSync(path.join(dir, ".env"));
    const rig = installerRig();
    const refused = withOwner(older, rig, dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/installation is damaged: .*\.env is missing/);
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
    expect(stageOf(dir)).toBe("images");
    expect(steps(rig).filter((call) => /^compose (up|run|stop)/.test(call))).toEqual([]);
  });

  it("a folder whose path has spaces and national letters installs, is interrupted and continues, in both modes", async () => {
    const local = path.join(nextDir("Moje dane"), "Instalacja żółta ąę");
    mkdirSync(path.dirname(local), { recursive: true });
    await interruptedRun(older, installerRig({ docker: { upHangsOnCall: 1 } }), local);
    const rig = installerRig();
    const finished = withOwner(older, rig, local);
    expect(finished.status, finished.stderr).toBe(0);
    expect(stageOf(local)).toBe("complete");
    for (const call of dockerCalls(rig).filter((line) => line.includes(" :: compose "))) expect(call.startsWith(`${local} :: `)).toBe(true);

    const server = path.join(nextDir("Serwer dane"), "Instalacja żółta ąę");
    mkdirSync(path.dirname(server), { recursive: true });
    for (let run = 0; run < 2; run += 1) {
      const result = runInstaller(installerRig({ system: LINUX }), ["--dir", server, "--yes", ...SERVER_ARGS], { script: scriptOf(older) });
      expect(result.status, result.stderr).toBe(3);
    }
    expect(stageOf(server)).toBe("files");
  });
});
