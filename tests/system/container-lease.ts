// D04.1-AC1/AC2 — the writer lease in the app image on this host's native architecture, with the
// installation bind-mounted into every container (Architektura §4.8, §15.1). Two containers on
// the same mounts give one writer: the second exits 1 with INSTANCE_BUSY. After `docker kill`
// (SIGKILL) a new container recovers the lease on the same lock file. On a Linux host, whose
// kernel the containers share, a host process holding the lease also stops a container, and a
// snapshot operation it left unfinished keeps the next container closed. Docker Desktop: D07.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { buildAppImage, docker, hostTestInstance, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { outputEvent, startWriterHolder, waitForExit } from "../support/server-process.ts";

const IMAGE = "openlife-app:verify-d04-lease";
const RUN_ID = randomBytes(4).toString("hex");
const READY_TIMEOUT_MS = 60_000;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`writer lease across containers on ${platform}`);
const instance = hostTestInstance();
const lockFile = path.join(instance.dir, "control", "maintenance", "writer.lock");
const stateFile = path.join(instance.dir, "control", "maintenance", "state.json");
const containers: string[] = [];
const evidence: Record<string, unknown> = {};

// The containers run as the owner of the bind-mounted folders, like the installer's non-root setup.
const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
const mounts = [
  "--env-file", instance.envFile,
  "--user", user,
  "--volume", `${path.join(instance.dir, "data")}:/data`,
  "--volume", `${path.join(instance.dir, "control", "maintenance")}:/control/maintenance`,
  "--volume", `${instance.instanceFile}:/instance/instance.json:ro`,
];

function startDetached(name: string): boolean {
  const run = docker(["run", "--detach", "--name", name, "--platform", platform, ...mounts, IMAGE], repoRoot);
  containers.push(name);
  return run.status === 0;
}

async function waitForLog(name: string, marker: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let logs = "";
  while (Date.now() < deadline) {
    logs = docker(["logs", name], repoRoot).output;
    if (logs.includes(marker)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return logs;
}

function runToExit(): { status: number | null; output: string } {
  return docker(["run", "--rm", "--platform", platform, ...mounts, IMAGE], repoRoot);
}

try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const first = `openlife-d04-a-${RUN_ID}`;
    check.expect(startDetached(first), "container A starts on the bind-mounted installation");
    const firstLogs = await waitForLog(first, '"server.listening"');
    check.expect(firstLogs.includes('"server.listening"'), "container A holds the lease and listens", firstLogs);
    const inode = statSync(lockFile).ino;

    const second = runToExit();
    evidence["second"] = outputEvent(second.output, "bootstrap.failed");
    check.expect(second.status === 1, `container B on the same mounts exits 1 (got ${second.status})`, second.output);
    check.expect(
      JSON.stringify(outputEvent(second.output, "bootstrap.failed")) === '{"event":"bootstrap.failed","code":"INSTANCE_BUSY","fields":["writer.lock"]}',
      "container B reports INSTANCE_BUSY [writer.lock] and does not listen",
      second.output,
    );

    const kill = docker(["kill", "--signal", "KILL", first], repoRoot);
    docker(["wait", first], repoRoot);
    check.expect(kill.status === 0, "docker kill --signal KILL stops container A", kill.output);
    const third = `openlife-d04-c-${RUN_ID}`;
    check.expect(startDetached(third), "container C starts after SIGKILL of A");
    const thirdLogs = await waitForLog(third, '"server.listening"');
    evidence["recovered"] = outputEvent(thirdLogs, "bootstrap.ready")?.["maintenance"];
    check.expect(thirdLogs.includes('"server.listening"'), "container C recovers the lease and listens", thirdLogs);
    check.expect(statSync(lockFile).ino === inode, "the lock file keeps its inode: never unlinked or replaced");
    const stop = docker(["stop", "--time", "20", third], repoRoot, 60_000);
    check.expect(stop.status === 0 && docker(["inspect", "--format", "{{.State.ExitCode}}", third], repoRoot).output.trim() === "0", "container C stops cleanly");

    if (process.platform === "linux") {
      const holder = await startWriterHolder(instance.dir, ["--begin", "snapshot"]);
      const blocked = runToExit();
      evidence["hostHolder"] = outputEvent(blocked.output, "bootstrap.failed");
      check.expect(
        blocked.status === 1 && outputEvent(blocked.output, "bootstrap.failed")?.["code"] === "INSTANCE_BUSY",
        "a host process holding the lease stops a container with INSTANCE_BUSY",
        blocked.output,
      );
      holder.child.kill("SIGKILL");
      await waitForExit(holder.child, () => "", 15_000);
      const before = readFileSync(stateFile, "utf8");
      const recovery = runToExit();
      evidence["unfinishedOperation"] = outputEvent(recovery.output, "bootstrap.failed");
      check.expect(
        recovery.status === 1 &&
          JSON.stringify(outputEvent(recovery.output, "bootstrap.failed")) ===
            '{"event":"bootstrap.failed","code":"MAINTENANCE_RECOVERY_REQUIRED","fields":["activeOperation"]}',
        "an operation left by the killed host writer keeps the container closed",
        recovery.output,
      );
      check.expect(readFileSync(stateFile, "utf8") === before, "the refused start leaves state.json unchanged");
    }
  }
} finally {
  for (const name of containers) docker(["rm", "--force", name], repoRoot);
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  rmSync(path.dirname(instance.dir), { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, `container-lease-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
