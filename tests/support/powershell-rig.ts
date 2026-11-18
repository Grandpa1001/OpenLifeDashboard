// A rig for install/install.ps1 without Windows (DEV §9.58): PowerShell 7 in a Linux container, a fake `docker` that records its
// calls, and a copy of the installer that believes it runs on Windows (the one constant `$RequiredPlatform` is changed, so every
// other line is the one that Windows runs). What only Windows can show (ACL, Windows PowerShell 5.1, a drive letter) is D59.3.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "./repository-copy.ts";

export const POWERSHELL_IMAGE = "mcr.microsoft.com/powershell:7.4-ubuntu-22.04";
/** The image is amd64 only; on an arm64 computer it runs emulated. */
const PLATFORM = "linux/amd64";

export type FakeWindowsDocker = "ok" | "down" | "windows-containers" | "old-compose" | "absent";

export type PowerShellRig = Readonly<{
  /** The work folder, mounted at /work in the container. */
  work: string;
  /** Runs the installer; `bash` is a script run first in the same container (e.g. to hold a port), `original` runs the script as it is in the repository. */
  run: (args: readonly string[], options?: Readonly<{ docker?: FakeWindowsDocker; original?: boolean; before?: string }>) => Readonly<{ status: number | null; output: string }>;
  /** The docker calls the installer made (the probes included). */
  dockerCalls: () => string[];
  /** Reads a file of the work folder. */
  read: (relative: string) => string;
  cleanup: () => void;
}>;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> /work/docker-calls.log
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

  const run: PowerShellRig["run"] = (args, options = {}) => {
    const script = options.original ? "/repo/install/install.ps1" : "/work/tree/install/install.ps1";
    const quoted = args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
    const path_ = options.docker === "absent" ? "/usr/bin:/bin:/opt/microsoft/powershell/7" : "/work/bin:/usr/bin:/bin:/opt/microsoft/powershell/7";
    const command = `${options.before ?? ""}\npwsh -NoProfile -NonInteractive -File ${script} ${quoted}`;
    const result = spawnSync(
      "docker",
      ["run", "--rm", "--platform", PLATFORM, "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "-v", `${repoRoot}:/repo:ro`, "-v", `${work}:/work`, "-w", "/work", "-e", `PATH=${path_}`, "-e", `FAKE_DOCKER=${options.docker ?? "ok"}`, "-e", "HOME=/work/home", POWERSHELL_IMAGE, "bash", "-c", command],
      { encoding: "utf8", timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const read = (relative: string): string => readFileSync(path.join(work, relative), "utf8");
  const dockerCalls = (): string[] => {
    try {
      return read("docker-calls.log").split("\n").filter((line) => line !== "");
    } catch {
      return [];
    }
  };
  return { work, run, dockerCalls, read, cleanup: () => spawnSync("rm", ["-rf", work]) && undefined };
}
