// A rig for install/install.sh without Docker (DEV D19.1): a tools folder that is the whole PATH of
// the installer, with an optional fake `docker` whose answers a test chooses, and a runner.
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./scratch.ts";

export const INSTALLER = fileURLToPath(new URL("../../install/install.sh", import.meta.url));

/** Commands the installer may use (plus `sleep` and `touch` for the fake docker); nothing else is on its PATH. */
const TOOLS = ["env", "bash", "uname", "id", "od", "tr", "cut", "sed", "awk", "df", "find", "head", "mkdir", "mv", "rm", "cat", "date", "dirname", "sleep", "touch"];

export type FakeDocker = Readonly<{
  /** `docker version` fails as when the daemon is not running. */
  daemonDown?: boolean;
  engineVersion?: string;
  engineOs?: string;
  composeVersion?: string;
  /** `docker compose` is not available. */
  composeMissing?: boolean;
  /** `docker version` blocks (to interrupt the installer while it waits). */
  hang?: boolean;
}>;

export type InstallerRig = Readonly<{
  binDir: string;
  /** Written by the fake docker when it starts, so a test knows the installer is waiting. */
  startedMarker: string;
}>;

function which(tool: string): string {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  if (!found) throw new Error(`the tool ${tool} is needed by the installer tests`);
  return found;
}

export function installerRig(options: Readonly<{ docker?: FakeDocker | false; userId?: number }> = {}): InstallerRig {
  const binDir = scratchDir("openlife-installer-bin-");
  const startedMarker = path.join(binDir, "docker-started");
  // `id -u` / `id -g` answer with the chosen user (0 = root) instead of the real tool.
  for (const tool of TOOLS.filter((name) => name !== "id" || options.userId === undefined)) symlinkSync(which(tool), path.join(binDir, tool));
  if (options.userId !== undefined) {
    writeFileSync(path.join(binDir, "id"), `#!/usr/bin/env bash\necho ${options.userId}\n`, { mode: 0o755 });
  }
  if (options.docker !== false) {
    const fake = options.docker ?? {};
    const script = [
      "#!/usr/bin/env bash",
      `touch ${JSON.stringify(startedMarker)}`,
      fake.hang ? "sleep 30" : "",
      'if [ "$1" = "version" ]; then',
      fake.daemonDown ? '  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1' : `  echo "${fake.engineVersion ?? "27.3.1"}|${fake.engineOs ?? "linux"}"; exit 0`,
      "fi",
      'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then',
      fake.composeMissing ? '  echo "docker: unknown command: docker compose" >&2; exit 1' : `  echo "${fake.composeVersion ?? "v2.29.1"}"; exit 0`,
      "fi",
      "exit 1",
      "",
    ].join("\n");
    const file = path.join(binDir, "docker");
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return { binDir, startedMarker };
}

export type InstallerRun = Readonly<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;

export function runInstaller(rig: InstallerRig, args: readonly string[], home = rig.binDir): InstallerRun {
  const result = spawnSync("bash", [INSTALLER, ...args], {
    encoding: "utf8",
    // HOME is only a place for the default folder; stdin is not a terminal, so nothing is asked.
    env: { PATH: rig.binDir, HOME: home },
    input: "",
    timeout: 60_000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

/** Starts the installer in its own process group, so a test can interrupt it like Ctrl+C does. */
export function startInstaller(rig: InstallerRig, args: readonly string[]) {
  const child = spawn("bash", [INSTALLER, ...args], { env: { PATH: rig.binDir, HOME: rig.binDir }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => child.once("exit", (code) => resolve({ code, stderr })));
  return { child, exit, interrupt: () => process.kill(-(child.pid ?? 0), "SIGINT") };
}
