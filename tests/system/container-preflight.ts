// D03.4-AC2 — storage preflight inside the app image, run by its non-root user on this host's
// native architecture: a read-only file system stops the start (STORAGE_UNWRITABLE), a data
// mount smaller than the disk reserve stops it (STORAGE_LOW_SPACE), and an unwritable log
// folder only degrades it. No output may contain the installation secrets.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { buildAppImage, containerInstanceArgs, docker, hostTestInstance, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-d03-preflight";
const CONTAINER = `openlife-d03-${randomBytes(4).toString("hex")}`;
// Far below the default 512 MiB reserve (backup.diskReserveMiB).
const SMALL_DATA_MOUNT = "size=32m,mode=1777";
const START_WITH_DATA_DIRS = "mkdir -p /data/backup /data/logs/app /data/tmp && exec node apps/server/dist/main.js --host 0.0.0.0";
const READY_TIMEOUT_MS = 60_000;

const events = (output: string): JsonObject[] =>
  output.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isJsonObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });
const failure = (output: string): JsonObject | undefined => events(output).find((event) => event["event"] === "bootstrap.failed");
const fieldsOf = (event: JsonObject | undefined): string[] =>
  Array.isArray(event?.["fields"]) ? event["fields"].map(String).sort() : [];

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`storage preflight in the app container on ${platform}`);
const instance = hostTestInstance();
const outputs: Record<string, string> = {};

try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const base = ["run", "--rm", "--platform", platform, ...containerInstanceArgs(instance)];
    const uid = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"], repoRoot).output.trim();
    check.expect(uid !== "" && uid !== "0", `the image runs the check as non-root uid ${uid}`);

    const readOnly = docker([...base, "--read-only", IMAGE], repoRoot);
    outputs["readOnly"] = readOnly.output;
    check.expect(readOnly.status === 1, `read-only file system → exit 1 (got ${readOnly.status})`, readOnly.output);
    check.expect(
      failure(readOnly.output)?.["code"] === "STORAGE_UNWRITABLE" &&
        JSON.stringify(fieldsOf(failure(readOnly.output))) === JSON.stringify(["backups", "data", "maintenance", "tmp"]),
      "read-only file system → STORAGE_UNWRITABLE for every critical folder",
      readOnly.output,
    );

    const small = docker([...base, "--tmpfs", `/data:${SMALL_DATA_MOUNT}`, "--entrypoint", "sh", IMAGE, "-c", START_WITH_DATA_DIRS], repoRoot);
    outputs["lowSpace"] = small.output;
    check.expect(small.status === 1, `32 MiB data mount → exit 1 (got ${small.status})`, small.output);
    check.expect(
      failure(small.output)?.["code"] === "STORAGE_LOW_SPACE" && JSON.stringify(fieldsOf(failure(small.output))) === '["data"]',
      "32 MiB data mount below the 512 MiB reserve → STORAGE_LOW_SPACE [data]",
      small.output,
    );

    const degraded = docker(
      ["run", "--detach", "--name", CONTAINER, "--platform", platform, "--publish", "127.0.0.1::8080", ...containerInstanceArgs(instance),
        "--tmpfs", "/data/logs/app:mode=0555", IMAGE],
      repoRoot,
    );
    check.expect(degraded.status === 0, "container with a read-only log folder starts", degraded.output);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let logs = "";
    while (Date.now() < deadline && !logs.includes('"server.listening"')) {
      logs = docker(["logs", CONTAINER], repoRoot).output;
      if (!logs.includes('"server.listening"')) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const port = /:(\d+)$/.exec(docker(["port", CONTAINER, "8080/tcp"], repoRoot).output.trim().split("\n")[0] ?? "")?.[1];
    const health = port ? await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.status, () => 0) : 0;
    docker(["stop", "--time", "20", CONTAINER], repoRoot, 60_000);
    logs = docker(["logs", CONTAINER], repoRoot).output;
    outputs["degradedLogs"] = logs;
    check.expect(
      logs.includes('{"event":"bootstrap.degraded","code":"LOG_SINK_UNAVAILABLE","fields":["logs"]}'),
      "read-only log folder → bootstrap.degraded LOG_SINK_UNAVAILABLE",
      logs,
    );
    check.expect(health === 200, `the degraded server still serves /api/health (got ${health})`, logs);
  }

  for (const [name, output] of Object.entries(outputs)) {
    check.expect(instance.secrets.every((secret) => !output.includes(secret)), `${name}: output contains no installation secret`);
  }
} finally {
  docker(["rm", "--force", CONTAINER], repoRoot);
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  rmSync(path.dirname(instance.dir), { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    const summary = Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, events(output).filter((e) => String(e["event"]).startsWith("bootstrap."))]));
    writeFileSync(path.join(evidenceDir, `container-preflight-${arch}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  }
}
check.finish();
