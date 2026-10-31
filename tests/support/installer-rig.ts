// A rig for install/install.sh without Docker (DEV D19.1, D19.2): a tools folder that is the whole
// PATH of the installer, an optional fake `docker` whose answers a test chooses and which records
// every call, and a runner.
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./scratch.ts";

export const INSTALLER = fileURLToPath(new URL("../../install/install.sh", import.meta.url));

/** Commands the installer may use (plus `sleep` for the fake docker); nothing else is on its PATH. */
const TOOLS = ["env", "bash", "uname", "id", "od", "tr", "cut", "sed", "awk", "df", "find", "head", "mkdir", "mv", "rm", "cat", "date", "dirname", "sleep"];

/**
 * How the fake docker blocks so that Ctrl+C always reaches it. The marker is written by a shell
 * builtin and the wait replaces the script (`exec`): a SIGINT sent once the marker exists finds
 * either the script running builtins (it dies) or `sleep` itself (it dies). With an external
 * command before the wait, a SIGINT arriving while bash still waited for that command, which had
 * already exited normally, was dropped by bash ("wait and cooperative exit"), and the installer
 * then waited the whole sleep.
 */
const block = (marker: string): string => `: > ${sh(marker)}; exec sleep 30`;

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
  /** The image is not on the computer (`image inspect` fails) and `pull` fails when set. */
  imageMissing?: boolean;
  pullFails?: boolean;
  /** `compose up` fails on these calls (1 = the first). */
  upFailsOnCalls?: readonly number[];
  /** `compose up` blocks on this call, to interrupt the installer in the middle of a stage. */
  upHangsOnCall?: number;
  /** What the one-off create-owner container does: exit status and what it prints. */
  owner?: Readonly<{ exit: number; output: string }>;
}>;

export type InstallerRig = Readonly<{
  binDir: string;
  /** Written by the fake docker right before it blocks (`hang`, `upHangsOnCall`), so a test knows the installer is waiting. */
  blockedMarker: string;
  /** One line per docker call: the working folder and the arguments. */
  callLog: string;
  /** What the one-off owner container received on stdin and in its environment. */
  ownerStdin: string;
  ownerEnv: string;
}>;

function which(tool: string): string {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  if (!found) throw new Error(`the tool ${tool} is needed by the installer tests`);
  return found;
}

const sh = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

export function installerRig(options: Readonly<{ docker?: FakeDocker | false; userId?: number }> = {}): InstallerRig {
  const binDir = scratchDir("openlife-installer-bin-");
  const blockedMarker = path.join(binDir, "docker-blocked");
  const callLog = path.join(binDir, "docker-calls.log");
  const ownerStdin = path.join(binDir, "owner-stdin");
  const ownerEnv = path.join(binDir, "owner-env");
  // `id -u` / `id -g` answer with the chosen user (0 = root) instead of the real tool.
  for (const tool of TOOLS.filter((name) => name !== "id" || options.userId === undefined)) symlinkSync(which(tool), path.join(binDir, tool));
  if (options.userId !== undefined) {
    writeFileSync(path.join(binDir, "id"), `#!/usr/bin/env bash\necho ${options.userId}\n`, { mode: 0o755 });
  }
  if (options.docker !== false) {
    const fake = options.docker ?? {};
    const owner = fake.owner ?? { exit: 0, output: '{"event":"owner.created"}' };
    const failing = (fake.upFailsOnCalls ?? []).map((call) => `"$ups" = ${call}`).join(" ] || [ ");
    const script = [
      "#!/usr/bin/env bash",
      `echo "$PWD :: $*" >> ${sh(callLog)}`,
      fake.hang ? block(blockedMarker) : "",
      'if [ "$1" = "version" ]; then',
      fake.daemonDown ? '  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1' : `  echo "${fake.engineVersion ?? "27.3.1"}|${fake.engineOs ?? "linux"}"; exit 0`,
      "fi",
      'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then',
      fake.composeMissing ? '  echo "docker: unknown command: docker compose" >&2; exit 1' : `  echo "${fake.composeVersion ?? "v2.29.1"}"; exit 0`,
      "fi",
      'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
      fake.imageMissing ? "  exit 1" : "  exit 0",
      "fi",
      'if [ "$1" = "pull" ]; then',
      fake.pullFails ? '  echo "pull access denied or no network" >&2; exit 1' : "  exit 0",
      "fi",
      'if [ "$1" = "compose" ] && [ "$2" = "up" ]; then',
      `  ups=$(( $(cat ${sh(path.join(binDir, "ups"))} 2>/dev/null || echo 0) + 1 )); echo $ups > ${sh(path.join(binDir, "ups"))}`,
      fake.upHangsOnCall !== undefined ? `  if [ "$ups" = ${fake.upHangsOnCall} ]; then ${block(blockedMarker)}; fi` : "",
      failing ? `  if [ ${failing} ]; then echo "container is unhealthy" >&2; exit 1; fi` : "",
      "  exit 0",
      "fi",
      'if [ "$1" = "compose" ] && [ "$2" = "run" ]; then',
      `  cat > ${sh(ownerStdin)}`,
      `  env > ${sh(ownerEnv)}`,
      `  echo ${sh(owner.output)}`,
      `  exit ${owner.exit}`,
      "fi",
      'if [ "$1" = "compose" ]; then exit 0; fi',
      "exit 1",
      "",
    ].join("\n");
    const file = path.join(binDir, "docker");
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return { binDir, blockedMarker, callLog, ownerStdin, ownerEnv };
}

/** The recorded docker calls, without the version probes of the preflight. */
export function dockerCalls(rig: InstallerRig): string[] {
  if (!existsSync(rig.callLog)) return [];
  return readFileSync(rig.callLog, "utf8")
    .split("\n")
    .filter((line) => line !== "" && !/ :: (version|compose version)\b/.test(line));
}

export type InstallerRun = Readonly<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;

export type RunOptions = Readonly<{
  /** Stdin of the installer, e.g. the owner's password line for --owner-password-stdin. */
  input?: string;
}>;

export function runInstaller(rig: InstallerRig, args: readonly string[], options: RunOptions = {}): InstallerRun {
  const result = spawnSync("bash", [INSTALLER, ...args], {
    encoding: "utf8",
    // HOME is only a place for the default folder; stdin is not a terminal, so nothing is asked.
    env: { PATH: rig.binDir, HOME: rig.binDir },
    input: options.input ?? "",
    timeout: 60_000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

/** Starts the installer in its own process group, so a test can interrupt it like Ctrl+C does. */
export function startInstaller(rig: InstallerRig, args: readonly string[], input = "") {
  const child = spawn("bash", [INSTALLER, ...args], { env: { PATH: rig.binDir, HOME: rig.binDir }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  child.stdin.end(input);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => child.once("exit", (code) => resolve({ code, stderr })));
  return { child, exit, interrupt: () => process.kill(-(child.pid ?? 0), "SIGINT") };
}
