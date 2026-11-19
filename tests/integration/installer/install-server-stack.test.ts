// D60.4 — install.sh in the server mode goes through every stage against a fake Docker, a fake DNS and a fake curl (DEV §9.59,
// Architektura §12.4 points 6 to 10). The order is: the files, the images (Caddy's too), the application WITHOUT Caddy, the owner account
// from stdin, then Caddy, and the installation is complete only when https://<domain>/api/health answers. A domain that does not
// resolve, or a certificate that does not come, ends with the status 3 and "NOT installed", and the rerun continues with the same keys
// and one owner. A real daemon, a real Caddy and a certificate of its own authority are tests/system/install-server-linux.ts.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReleasePackage } from "../../../scripts/support/release-package.ts";
import { INSTALLER, dockerCalls, installerRig, runInstaller, startInstaller, type FakeDocker, type FakeSystem, type InstallerRig } from "../../support/installer-rig.ts";
import { repoRoot } from "../../support/server-process.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-install-stack-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const IMAGE = `registry.example.test/openlife/app@sha256:${"a".repeat(64)}`;
const DOMAIN = "dziennik.example.com";
const ACME = "admin@example.com";
const OWNER = "wlasciciel@example.com";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const OWNER_ARGS = ["--owner-email", OWNER, "--owner-password-stdin"] as const;
const system = (https: FakeSystem["https"] = "answers"): FakeSystem => ({ os: "Linux", dns: { [DOMAIN]: ["203.0.113.7"] }, https });
const pack = buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(root, "package"), version: "1.4.0", image: IMAGE });
const script = path.join(pack.folder, "install.sh");

let counter = 0;
const nextDir = (): string => path.join(root, `Serwer ${(counter += 1)}`);
const serverArgs = (dir: string, extra: readonly string[] = []): string[] => ["--mode", "server", "--dir", dir, "--domain", DOMAIN, "--acme-email", ACME, "--yes", ...extra];
const install = (rig: InstallerRig, dir: string, extra: readonly string[] = [], withOwner = true, installer = script) =>
  runInstaller(rig, serverArgs(dir, [...(withOwner ? OWNER_ARGS : []), ...extra]), { script: installer, ...(withOwner ? { input: `${PASSWORD}\n` } : {}) });
const steps = (rig: InstallerRig): string[] => dockerCalls(rig).map((line) => line.slice(line.indexOf(" :: ") + 4));
const stageOf = (dir: string): string => (JSON.parse(readFileSync(path.join(dir, "control", "install-state.json"), "utf8")) as { stage: string }).stage;
const identity = (dir: string): Record<string, string> => Object.fromEntries([".env", "control/instance.json", "control/compose.release.yml"].map((file) => [file, readFileSync(path.join(dir, file), "utf8")]));
const curlCalls = (rig: InstallerRig): string[] => (existsSync(path.join(rig.binDir, "curl-calls.log")) ? readFileSync(path.join(rig.binDir, "curl-calls.log"), "utf8").split("\n").filter(Boolean) : []);
const indexOf = (calls: readonly string[], pattern: RegExp): number => calls.findIndex((call) => pattern.test(call));

describe("D60.4-AC1 the stages of the server installation and what each one waits for", () => {
  it("starts the application without Caddy, creates the owner from stdin, then starts Caddy, and is complete only after the HTTPS answer", () => {
    const rig = installerRig({ system: system() });
    const dir = nextDir();
    const result = install(rig, dir);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("OpenLifeDashboard is installed");
    expect(result.stdout).toContain(`https://${DOMAIN}`);
    expect(result.stdout).not.toContain("NOT installed");
    expect(stageOf(dir)).toBe("complete");

    const calls = steps(rig);
    const appOnly = indexOf(calls, /^compose up --detach --wait --wait-timeout \d+ app$/);
    const owner = indexOf(calls, /^compose run /);
    const stopped = indexOf(calls, /^compose stop app$/);
    const everything = indexOf(calls, /^compose up --detach --wait --wait-timeout \d+$/);
    expect([appOnly, stopped, owner, everything].every((index) => index >= 0), calls.join("\n")).toBe(true);
    // The application is up alone first; Caddy comes only after the owner account was made.
    expect(appOnly).toBeLessThan(stopped);
    expect(stopped).toBeLessThan(owner);
    expect(owner).toBeLessThan(everything);
    expect(calls.filter((call) => /^compose up/.test(call))).toHaveLength(2);
    // The HTTPS answer was asked for after Caddy started, at the address of the domain.
    expect(curlCalls(rig).some((call) => call.includes(`https://${DOMAIN}/api/health`))).toBe(true);
    // The password reached the one-off container on stdin and nowhere else.
    expect(readFileSync(rig.ownerStdin, "utf8")).toBe(`{"email":"${OWNER}","password":"${PASSWORD}"}\n`);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).not.toContain("jaźń");
    expect(`${result.stdout}${result.stderr}`).not.toContain("jaźń");
    expect(readFileSync(rig.ownerEnv, "utf8")).not.toContain("jaźń");
  });

  it("pulls the images that the Compose files name beside the application, Caddy's too, before it starts anything", () => {
    const rig = installerRig({ system: system(), docker: { imageMissing: true } });
    const dir = nextDir();
    const result = install(rig, dir);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const calls = steps(rig);
    const pulls = calls.filter((call) => call.startsWith("pull "));
    expect(pulls).toEqual([`pull ${IMAGE}`, expect.stringMatching(/^pull caddy:2\.10\.2-alpine@sha256:[0-9a-f]{64}$/)]);
    expect(Math.max(...calls.map((call, index) => (call.startsWith("pull ") ? index : -1)))).toBeLessThan(indexOf(calls, /^compose up/));
  });

  it("takes the Compose files and the Caddyfile of the package it runs from, and stays at the stage 'complete' when run again", () => {
    const dir = nextDir();
    expect(install(installerRig({ system: system() }), dir).status).toBe(0);
    for (const file of ["compose.yml", "compose.server.yml", "Caddyfile"]) expect(readFileSync(path.join(dir, file), "utf8"), file).toBe(readFileSync(path.join(pack.folder, file), "utf8"));
    const before = identity(dir);
    const rig = installerRig({ system: system() });
    const again = install(rig, dir, [], false);
    expect(again.status, `${again.stdout}${again.stderr}`).toBe(0);
    expect(again.stdout).toContain("nothing was changed");
    expect(identity(dir)).toEqual(before);
    expect(steps(rig).filter((call) => /^compose (up|run|stop)/.test(call))).toEqual([]);
  });

  it("does not ask for the owner when the domain does not resolve, and asks for it when it does and none was given", () => {
    const waiting = installerRig({ system: { os: "Linux", dns: {} } });
    const dir = nextDir();
    const first = install(waiting, dir, [], false);
    expect(first.status, first.stderr).toBe(3);
    expect(first.stdout).toContain("Waiting for DNS");
    expect(stageOf(dir)).toBe("files");

    const missing = installerRig({ system: system() });
    const without = install(missing, dir, [], false);
    expect(without.status).toBe(2);
    expect(without.stderr).toContain("--owner-email is required");
    expect(stageOf(dir)).toBe("files");
    expect(steps(missing).filter((call) => /^compose (up|run|stop)/.test(call))).toEqual([]);

    const weak = runInstaller(installerRig({ system: system() }), serverArgs(dir, OWNER_ARGS), { script, input: "short\n" });
    expect(weak.status).toBe(1);
    expect(weak.stderr).toContain("password is refused");
    expect(stageOf(dir)).toBe("files");
  });
});

describe("D60.4-AC1 a certificate that does not come, and an interruption, continue with the same keys and one owner", () => {
  it("the HTTPS answer does not come in time: status 3, NOT installed, stage 'proxy'; the rerun keeps the keys and makes no second owner", () => {
    const dir = nextDir();
    const slow = installerRig({ system: system("never") });
    const first = install(slow, dir, ["--https-wait", "1"]);
    expect(first.status, `${first.stdout}${first.stderr}`).toBe(3);
    expect(first.stdout).toContain("NOT complete");
    expect(first.stdout).toContain("Waiting for the certificate");
    expect(first.stdout).not.toContain("OpenLifeDashboard is installed");
    expect(stageOf(dir)).toBe("proxy");
    expect(steps(slow).filter((call) => call.startsWith("compose run"))).toHaveLength(1);
    const before = identity(dir);

    const answering = installerRig({ system: system() });
    const second = install(answering, dir, [], false);
    expect(second.status, `${second.stdout}${second.stderr}`).toBe(0);
    expect(second.stdout).toContain("OpenLifeDashboard is installed");
    expect(stageOf(dir)).toBe("complete");
    expect(identity(dir)).toEqual(before);
    // Only the wait for the answer was repeated: nothing was stopped, started or created again.
    expect(steps(answering).filter((call) => /^compose (up|run|stop)/.test(call))).toEqual([]);
  });

  it("waits more than one try: the answer that comes on the third try completes it within the time given", () => {
    const rig = installerRig({ system: system("after:3") });
    const dir = nextDir();
    const result = install(rig, dir, ["--https-wait", "30"]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(curlCalls(rig).length).toBeGreaterThanOrEqual(3);
    expect(stageOf(dir)).toBe("complete");
  });

  it("Ctrl+C while Caddy starts keeps the owner and the keys, and the rerun finishes without a second owner", async () => {
    const dir = nextDir();
    const interrupted = installerRig({ system: system(), docker: { upHangsOnCall: 2 } });
    const started = startInstaller(interrupted, serverArgs(dir, OWNER_ARGS), `${PASSWORD}\n`, script);
    const deadline = Date.now() + 20_000;
    while (!existsSync(interrupted.blockedMarker)) {
      if (Date.now() > deadline) throw new Error("the installer never reached the blocking call");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    started.interrupt();
    expect((await started.exit).code).toBe(130);
    expect(stageOf(dir)).toBe("owner");
    const before = identity(dir);

    const rig = installerRig({ system: system() });
    const finished = install(rig, dir, [], false);
    expect(finished.status, `${finished.stdout}${finished.stderr}`).toBe(0);
    expect(stageOf(dir)).toBe("complete");
    expect(identity(dir)).toEqual(before);
    expect(steps(rig).filter((call) => call.startsWith("compose run"))).toEqual([]);
  });
});

describe("D60.4-AC1 the ports of Caddy are checked before Caddy exists and not when Caddy itself holds them", () => {
  // Ports 80 and 443 can be held only by a privileged user on some systems, so the installer is run as a copy whose list of ports is a
  // free high port that this test holds: the check that refuses is the same one.
  const holder = createServer();
  let held = 0;
  let changed = "";
  beforeAll(async () => {
    held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as AddressInfo).port)));
    const folder = path.join(root, "install-held-port");
    cpSync(path.dirname(INSTALLER), folder, { recursive: true });
    // A copy of the installer finds the Compose files in docker/ beside its own folder, as in the repository.
    cpSync(path.join(repoRoot, "docker"), path.join(root, "docker"), { recursive: true });
    changed = path.join(folder, "install.sh");
    const original = readFileSync(INSTALLER, "utf8");
    writeFileSync(changed, original.replace("readonly SERVER_PORTS=(80 443)", `readonly SERVER_PORTS=(${held})`), { mode: 0o755 });
  });
  afterAll(() => new Promise((resolve) => holder.close(resolve)));
  /** A server folder past the owner stage whose HTTPS answer did not come in time: the state 'proxy'. */
  const waitingFolder = (): string => {
    const dir = nextDir();
    expect(install(installerRig({ system: system("never") }), dir, ["--https-wait", "1"]).status).toBe(3);
    return dir;
  };

  it("a folder past the owner stage whose Caddy runs goes on although its port is held: the port is Caddy's own", () => {
    const dir = waitingFolder();
    const running = installerRig({ system: system() });
    writeFileSync(path.join(running.binDir, "caddy-running"), "");
    const goes = install(running, dir, ["--image", IMAGE], false, changed);
    expect(goes.status, `${goes.stdout}${goes.stderr}`).toBe(0);
  }, 60_000);

  it("a fresh folder is refused before anything is written while a stranger holds the port", () => {
    const folder = nextDir();
    const refused = install(installerRig({ system: system() }), folder, ["--image", IMAGE], true, changed);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(new RegExp(`port ${held} is already in use`));
    expect(existsSync(folder)).toBe(false);
  }, 60_000);

  it("a folder past the owner stage is refused when a stranger holds the port and Caddy does not run, and nothing changes", () => {
    const dir = waitingFolder();
    const stranger = install(installerRig({ system: system() }), dir, ["--image", IMAGE], false, changed);
    expect(stranger.status).toBe(1);
    expect(stranger.stderr).toMatch(new RegExp(`port ${held} is already in use`));
    expect(stageOf(dir)).toBe("proxy");
  }, 60_000);
});

describe("D60.4-AC1 the application is not public before it has an owner", () => {
  const publishing = (rig: InstallerRig): boolean => existsSync(path.join(rig.binDir, "caddy-running"));
  const failures: ReadonlyArray<readonly [string, FakeDocker]> = [
    ["the application does not become healthy", { upFailsOnCalls: [1] }],
    ["the owner account is refused", { owner: { exit: 1, output: '{"code":"INPUT_INVALID","fields":["password"]}' } }],
    ["the owner container fails", { owner: { exit: 1, output: '{"code":"DATABASE_ERROR"}' } }],
  ];
  for (const [name, docker] of failures) {
    it(`Caddy was never started when ${name}`, () => {
      const rig = installerRig({ system: system(), docker });
      const dir = nextDir();
      const result = install(rig, dir);
      expect(result.status).toBe(1);
      expect(publishing(rig), "Caddy started").toBe(false);
      expect(steps(rig).filter((call) => /^compose up/.test(call)).every((call) => call.endsWith(" app"))).toBe(true);
    });
  }
});
