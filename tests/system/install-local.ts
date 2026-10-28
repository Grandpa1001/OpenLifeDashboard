// D19.3 — install/install.sh with the real Docker, on this host's native architecture: a clean
// folder and a locally built image become a running installation whose owner signs in, the run
// is interrupted before and after the owner account and continues, a repeated run changes
// nothing, and two installations side by side stay apart. The owner's password is on the
// installer's stdin only; every place it could leak into is searched for it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort } from "../support/compose-instance.ts";
import { buildAppImage, docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-d19-install";
const INSTALLER = path.join(repoRoot, "install", "install.sh");
const OWNER_EMAIL = "właściciel@example.com";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
const TEN_MINUTES_S = 10 * 60;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`install.sh with Docker on ${platform}`);

const probe = docker(["compose", "version", "--short"], repoRoot);
if (probe.status !== 0) {
  check.expect(false, "the docker compose plugin is available", probe.output);
  check.finish();
  process.exit(process.exitCode ?? 1);
}

type Run = Readonly<{ status: number | null; output: string }>;

function install(dir: string, port: number, password: string | undefined): Run {
  const args = ["--dir", dir, "--port", String(port), "--image", IMAGE];
  const withOwner = password === undefined ? args : [...args, "--owner-email", OWNER_EMAIL, "--owner-password-stdin"];
  const result = spawnSync("bash", [INSTALLER, ...withOwner], { input: password === undefined ? "" : `${password}\n`, encoding: "utf8", timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const stageOf = (dir: string): string => {
  try {
    return (JSON.parse(readFileSync(path.join(dir, "control", "install-state.json"), "utf8")) as { stage?: string }).stage ?? "";
  } catch {
    return "";
  }
};
const envOf = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(path.join(dir, ".env"), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

function allFilesText(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.endsWith(".db") && !entry.name.includes("-wal") && !entry.name.includes("-shm")) parts.push(readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return parts.join("\n");
}

const compose = (dir: string, args: readonly string[]) => docker(["compose", ...args], dir, 120_000);
const containerOf = (dir: string): string => compose(dir, ["ps", "--quiet", "app"]).output.trim();

type SignIn = Readonly<{ status: number; cookies: readonly string[] }>;

async function signIn(port: number, password: string): Promise<SignIn> {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
    body: JSON.stringify({ email: OWNER_EMAIL, password }),
  });
  await response.text();
  return { status: response.status, cookies: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "") };
}

async function authenticated(port: number, cookies: readonly string[]): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/identity/status`, { headers: { cookie: cookies.join("; ") } });
  const body = (await response.json()) as { authenticated?: boolean };
  return body.authenticated === true;
}

const cookieNames = (cookies: readonly string[]): string[] => cookies.map((cookie) => cookie.slice(0, cookie.indexOf("="))).sort();

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-install-"));
const dirs: string[] = [];
const evidence: Record<string, unknown> = {};
try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    // ---- A: a clean folder with spaces and Polish letters becomes a running installation.
    const dirA = path.join(root, "Moja instalacja ąęść");
    const portA = await freeLoopbackPort();
    dirs.push(dirA);
    const startedAt = Date.now();
    const first = install(dirA, portA, PASSWORD);
    const seconds = (Date.now() - startedAt) / 1000;
    if (check.expect(first.status === 0, "install.sh exits 0 on a clean folder", first.output)) {
      check.expect(stageOf(dirA) === "complete", "the state of the installation is complete", stageOf(dirA));
      check.expect(seconds < TEN_MINUTES_S, `the installation took ${seconds.toFixed(0)} s, inside ten minutes (image already built)`);
      const health = await fetch(`http://127.0.0.1:${portA}/api/health`);
      check.expect(health.status === 200, "GET /api/health answers 200");
      const envA = envOf(dirA);
      check.expect((statSync(path.join(dirA, ".env")).mode & 0o777) === 0o600, ".env is readable by its owner only (600)");

      const id = containerOf(dirA);
      const inspected = docker(["inspect", id], repoRoot).output;
      const ports = (JSON.parse(inspected) as { NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> } }[])[0]?.NetworkSettings.Ports ?? {};
      check.expect(
        JSON.stringify(Object.keys(ports)) === '["8080/tcp"]' && ports["8080/tcp"]?.length === 1 && ports["8080/tcp"][0]?.HostIp === "127.0.0.1" && ports["8080/tcp"][0]?.HostPort === String(portA),
        "the application is published on 127.0.0.1 only, on the chosen port",
        JSON.stringify(ports),
      );

      const logs = compose(dirA, ["logs", "--no-color", "app"]).output;
      const places: [string, string][] = [
        ["the installation files", allFilesText(dirA)],
        ["the output of the installer", first.output],
        ["the configuration of the container", inspected],
        ["the log of the container", logs],
      ];
      for (const [name, text] of places) {
        check.expect(!text.includes(PASSWORD), `the password is not in ${name}`);
      }
      const envText = readFileSync(path.join(dirA, ".env"), "utf8");
      check.expect(!envText.includes(PASSWORD) && !envText.includes(OWNER_EMAIL), ".env holds neither the password nor the e-mail");
      check.expect(![envA["BETTER_AUTH_SECRET"] ?? "", envA["APP_ENCRYPTION_KEY"] ?? ""].some((key) => first.output.includes(key) || logs.includes(key)), "the installation keys are in neither the output nor the container log");

      const wrong = await signIn(portA, `${PASSWORD} x`);
      const right = await signIn(portA, PASSWORD);
      check.expect(wrong.status === 401 && wrong.cookies.length === 0, "a wrong password is refused without a cookie", String(wrong.status));
      check.expect(right.status === 200 && right.cookies.length > 0 && (await authenticated(portA, right.cookies)), "the owner signs in with the password given to the installer", String(right.status));

      // A repeated run changes nothing and does not recreate the container.
      const before = readFileSync(path.join(dirA, ".env"), "utf8");
      const again = install(dirA, portA, undefined);
      check.expect(again.status === 0 && again.output.includes("nothing was changed"), "a second run of a complete installation only shows its status", again.output);
      check.expect(readFileSync(path.join(dirA, ".env"), "utf8") === before && containerOf(dirA) === id, "the second run keeps the keys and the very same container");
      evidence["clean"] = { seconds, cookieNames: cookieNames(right.cookies) };

      // ---- B: stopped at the owner stage (the password is refused), then continued.
      const dirB = path.join(root, "druga instalacja");
      const portB = await freeLoopbackPort();
      dirs.push(dirB);
      const refused = install(dirB, portB, "short");
      check.expect(refused.status === 1 && stageOf(dirB) === "started", "a password the application refuses stops the installer at the stage 'started'", `${stageOf(dirB)}\n${refused.output}`);
      check.expect(!refused.output.includes("short\n") && /"password"/.test(refused.output), "the message names the refused field and not its value", refused.output);
      check.expect(compose(dirB, ["ps", "--status", "running", "--quiet"]).output.trim() === "", "the application is stopped while there is no owner (no second writer)");
      const keysB = readFileSync(path.join(dirB, ".env"), "utf8");
      const continued = install(dirB, portB, PASSWORD);
      check.expect(continued.status === 0 && stageOf(dirB) === "complete", "the rerun with a valid password finishes the installation", continued.output);
      check.expect(readFileSync(path.join(dirB, ".env"), "utf8") === keysB, "the rerun keeps the keys of the first run");
      const signedB = await signIn(portB, PASSWORD);
      check.expect(signedB.status === 200 && (await authenticated(portB, signedB.cookies)), "the owner of the continued installation signs in");

      // ---- C: interrupted right after the owner account was created, then continued without a password.
      const dirC = path.join(root, "trzecia");
      const portC = await freeLoopbackPort();
      dirs.push(dirC);
      const child = spawn("bash", [INSTALLER, "--dir", dirC, "--port", String(portC), "--image", IMAGE, "--owner-email", OWNER_EMAIL, "--owner-password-stdin"], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.end(`${PASSWORD}\n`);
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      let interrupted = false;
      const deadline = Date.now() + INSTALL_TIMEOUT_MS;
      while (Date.now() < deadline && child.exitCode === null) {
        if (stageOf(dirC) === "owner") {
          process.kill(-(child.pid ?? 0), "SIGINT");
          interrupted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      const exitCode = await exited;
      evidence["interruptedAfterOwner"] = { interrupted, exitCode, stage: stageOf(dirC) };
      check.expect(interrupted && exitCode === 130 && stageOf(dirC) === "owner", "Ctrl+C right after the owner account was created ends with 130 and the stage 'owner'", JSON.stringify(evidence["interruptedAfterOwner"]));
      const finished = install(dirC, portC, undefined);
      check.expect(finished.status === 0 && stageOf(dirC) === "complete", "the rerun needs no password and finishes", finished.output);
      check.expect(!finished.output.includes("creating the owner account"), "the rerun does not create a second owner account", finished.output);
      const signedC = await signIn(portC, PASSWORD);
      check.expect(signedC.status === 200 && (await authenticated(portC, signedC.cookies)), "the owner created before the interruption signs in");

      // ---- Isolation: three installations on one computer.
      const envs = [dirA, dirB, dirC].map(envOf);
      check.expect(new Set(envs.map((env) => env["COMPOSE_PROJECT_NAME"])).size === 3, "the three installations have three Compose projects");
      check.expect(new Set(envs.map((env) => env["BETTER_AUTH_SECRET"])).size === 3 && new Set(envs.map((env) => env["APP_ENCRYPTION_KEY"])).size === 3, "the three installations have their own keys");
      check.expect(new Set([portA, portB, portC]).size === 3, "the three installations have their own ports");
      check.expect(new Set([dirA, dirB, dirC].map(containerOf)).size === 3, "the three installations have their own containers");
      const namesA = cookieNames(right.cookies);
      const namesB = cookieNames(signedB.cookies);
      check.expect(JSON.stringify(namesA) !== JSON.stringify(namesB), "the cookies of two installations on localhost have different names", `${namesA.join(",")} | ${namesB.join(",")}`);
      check.expect(!(await authenticated(portB, right.cookies)) && !(await authenticated(portA, signedB.cookies)), "the session of one installation does not open the other");
    }
  }
} finally {
  for (const dir of dirs) {
    try {
      docker(["compose", "down", "--timeout", "10"], dir);
    } catch {
      // The folder may not exist when an early step failed.
    }
  }
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  rmSync(root, { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, `install-local-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
