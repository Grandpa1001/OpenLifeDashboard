// A rig for install/install.ps1 without Windows (DEV §9.58): PowerShell 7 in a Linux container, a fake `docker` that records its
// calls, and a copy of the installer that believes it runs on Windows (the one constant `$RequiredPlatform` is changed, so every
// other line is the one that Windows runs). What only Windows can show (ACL, Windows PowerShell 5.1, a drive letter) is D59.3.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { repoRoot } from "./repository-copy.ts";

export const POWERSHELL_IMAGE = "mcr.microsoft.com/powershell:7.4-ubuntu-22.04";
/** The image is amd64 only; on an arm64 computer it runs emulated. */
const PLATFORM = "linux/amd64";

let counter = 0;

export type FakeWindowsDocker = "ok" | "down" | "windows-containers" | "old-compose" | "absent";

export type RunOptions = Readonly<{ docker?: FakeWindowsDocker; original?: boolean; before?: string; env?: Readonly<Record<string, string>>; stdin?: string }>;

export type PowerShellRig = Readonly<{
  /** The work folder, mounted at /work in the container. */
  work: string;
  /** Runs the installer; `before` is a script run first in the same container (e.g. to hold a port), `original` runs the script as it is in the repository, `env` shapes the fake docker. `stdin` is the input of the installer. */
  run: (args: readonly string[], options?: RunOptions) => Readonly<{ status: number | null; output: string }>;
  /** Runs the installer in the background, waits until the fake docker blocks (FAKE_HANG), sends Ctrl+C and returns what the installer did. */
  interrupt: (args: readonly string[], options?: RunOptions) => Promise<Readonly<{ status: number | null; output: string }>>;
  /** The docker calls the installer made (the probes included). */
  dockerCalls: () => string[];
  /** Reads a file of the work folder. */
  read: (relative: string) => string;
  cleanup: () => void;
}>;

/**
 * The fake docker. FAKE_DOCKER chooses what the environment is (ok, down, windows-containers, old-compose); the others shape the
 * stages: FAKE_IMAGE_MISSING (image inspect fails) with FAKE_PULL_FAILS, FAKE_UP_FAILS (the numbers of the `compose up` calls that
 * fail, e.g. "1 3"), FAKE_OWNER_EXIT and FAKE_OWNER_OUTPUT (the one-off owner container), and FAKE_HANG (pull, up or owner) which
 * writes /work/blocked and waits so that a test can send Ctrl+C. The stdin and the environment of the owner container are kept.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> /work/docker-calls.log
hang() { : > /work/blocked; exec sleep 60; }
case "$FAKE_DOCKER" in
  down) if [ "$1" = "version" ]; then echo "Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine" >&2; exit 1; fi ;;
esac
if [ "$1" = "version" ]; then
  if [ "$FAKE_DOCKER" = "windows-containers" ]; then echo "27.3.1|windows"; else echo "27.3.1|linux"; fi
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then
  if [ "$FAKE_DOCKER" = "old-compose" ]; then echo "v2.10.0"; else echo "v2.29.1-desktop.1"; fi
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  if [ -n "$FAKE_IMAGE_MISSING" ]; then exit 1; fi
  exit 0
fi
if [ "$1" = "pull" ]; then
  if [ "$FAKE_HANG" = "pull" ]; then hang; fi
  if [ -n "$FAKE_PULL_FAILS" ]; then echo "pull access denied or no network" >&2; exit 1; fi
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "up" ]; then
  ups=$(( $(cat /work/ups 2>/dev/null || echo 0) + 1 )); echo $ups > /work/ups
  if [ "$FAKE_HANG" = "up" ] && [ "$ups" = "\${FAKE_HANG_ON:-1}" ]; then hang; fi
  for n in $FAKE_UP_FAILS; do if [ "$n" = "$ups" ]; then echo "container is unhealthy" >&2; exit 1; fi; done
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "run" ]; then
  cat > /work/owner-stdin
  env > /work/owner-env
  if [ "$FAKE_HANG" = "owner" ]; then hang; fi
  echo "\${FAKE_OWNER_OUTPUT:-owner created}"
  exit "\${FAKE_OWNER_EXIT:-0}"
fi
exit 0
`;

export function powershellRig(): PowerShellRig {
  const work = mkdtempSync(path.join(os.tmpdir(), "openlife-pwsh-"));
  mkdirSync(path.join(work, "bin"));
  writeFileSync(path.join(work, "bin", "docker"), FAKE_DOCKER, { mode: 0o755 });
  // A tree like the repository's (install/ and docker/) in which the platform constant says Windows.
  mkdirSync(path.join(work, "tree", "install"), { recursive: true });
  mkdirSync(path.join(work, "tree", "docker"));
  for (const file of ["compose.yml", "compose.local.yml"]) cpSync(path.join(repoRoot, "docker", file), path.join(work, "tree", "docker", file));
  const original = readFileSync(path.join(repoRoot, "install", "install.ps1"), "utf8");
  const asWindows = original.replace("$RequiredPlatform = 'Win32NT'", "$RequiredPlatform = 'Unix'");
  if (asWindows === original) throw new Error("install.ps1 has no $RequiredPlatform line to change");
  writeFileSync(path.join(work, "tree", "install", "install.ps1"), asWindows);

  const dockerArgs = (options: RunOptions, args: readonly string[], name?: string): string[] => {
    const script = options.original ? "/repo/install/install.ps1" : "/work/tree/install/install.ps1";
    const quoted = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
    const searchPath = options.docker === "absent" ? "/usr/bin:/bin:/opt/microsoft/powershell/7" : "/work/bin:/usr/bin:/bin:/opt/microsoft/powershell/7";
    const command = `${options.before ?? ""}\nexec pwsh -NoProfile -NonInteractive -File ${script} ${quoted}`;
    const env = Object.entries({ PATH: searchPath, FAKE_DOCKER: options.docker ?? "ok", HOME: "/work/home", ...options.env }).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    return ["run", "--rm", "-i", "--init", ...(name === undefined ? [] : ["--name", name]), "--platform", PLATFORM, "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "-v", `${repoRoot}:/repo:ro`, "-v", `${work}:/work`, "-w", "/work", ...env, POWERSHELL_IMAGE, "bash", "-c", command];
  };
  const run: PowerShellRig["run"] = (args, options = {}) => {
    const result = spawnSync("docker", dockerArgs(options, args), { input: options.stdin ?? "", encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const interrupt: PowerShellRig["interrupt"] = async (args, options = {}) => {
    const name = `openlife-pwsh-${process.pid}-${(counter += 1)}`;
    const child = spawn("docker", dockerArgs({ ...options, env: { ...options.env } }, args, name), { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stdin.end(options.stdin ?? "");
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const deadline = Date.now() + 4 * 60 * 1000;
    while (!existsSync(path.join(work, "blocked"))) {
      if (Date.now() > deadline) {
        spawnSync("docker", ["kill", name]);
        throw new Error(`the installer never reached the blocking call\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    spawnSync("docker", ["kill", "--signal", "INT", name]);
    const status = await exited;
    rmSync(path.join(work, "blocked"), { force: true });
    return { status, output };
  };
  const read = (relative: string): string => readFileSync(path.join(work, relative), "utf8");
  const dockerCalls = (): string[] => {
    try {
      return read("docker-calls.log").split("\n").filter((line) => line !== "");
    } catch {
      return [];
    }
  };
  return { work, run, interrupt, dockerCalls, read, cleanup: () => spawnSync("rm", ["-rf", work]) && undefined };
}
