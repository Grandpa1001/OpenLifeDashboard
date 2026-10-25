// D07.2 — what survives on the real mounts of a Compose installation, on this host's native
// architecture. The same folders are read from the host while the app is stopped, so the state is
// really read, not assumed: the migration manifest, the installation ID (database and
// instance.json), the maintenance gate, a finished database snapshot and the log file.
// AC1: after two restarts (start, restart) and after down/up (the container is gone and a new one
//      is created) all of it is unchanged, the snapshot still verifies, the log only grew and the
//      app reports an existing installation, not a created one.
// AC2: removing the container removes no data; a container started without a required mount does
//      not create an installation in its own file system, and neither does Compose when a host
//      folder is missing; with the folders present nothing of the installation was touched.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyDatabaseSnapshot } from "../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort, prepareComposeInstance, type ComposeInstance } from "../support/compose-instance.ts";
import { buildAppImage, containerInstanceArgs, docker, requireNativeDocker, type ContainerMounts } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-d07-persistence";
const SNAPSHOT_SCRIPT = path.join(repoRoot, "tests/system/in-container/create-snapshot.mjs");
const READY_TIMEOUT_MS = 90_000;
const REQUESTS_PER_START = 2;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`persistence on Compose mounts on ${platform}`);
if (docker(["compose", "version", "--short"], repoRoot).status !== 0) {
  check.expect(false, "the docker compose plugin is available");
  check.finish();
  process.exit(process.exitCode ?? 1);
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const text = (value: unknown): string => JSON.stringify(value);
const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

type InstallationState = Readonly<{
  manifest: unknown;
  instance: unknown;
  integrity: unknown;
  foreignKeys: unknown;
  gate: unknown;
  instanceJson: string;
  snapshots: readonly Readonly<{ name: string; hashes: readonly string[]; verified: boolean }>[];
  log: string;
}>;

/** Reads the installation from the host; only while the app is stopped (the WAL is then settled). */
function readState(dir: string): InstallationState {
  const reader = openDatabase(path.join(dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  let database: Pick<InstallationState, "manifest" | "instance" | "integrity" | "foreignKeys">;
  try {
    database = {
      manifest: reader.handle.prepare("SELECT version, id, checksum, applied_at FROM schema_migration ORDER BY version").all(),
      instance: reader.handle.prepare("SELECT singleton, instance_id, created_at FROM instance").all(),
      integrity: reader.handle.pragma("integrity_check", { simple: true }),
      foreignKeys: reader.handle.pragma("foreign_key_check"),
    };
  } finally {
    reader.close();
  }
  const backups = path.join(dir, "data", "backup");
  const snapshots = readdirSync(backups)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({
      name,
      hashes: readdirSync(path.join(backups, name)).sort().map((file) => sha256(path.join(backups, name, file))),
      verified: verifyDatabaseSnapshot(path.join(backups, name)).ok,
    }));
  const logFile = path.join(dir, "data", "logs", "app", "app.jsonl");
  return {
    ...database,
    gate: JSON.parse(readFileSync(path.join(dir, "control", "maintenance", "state.json"), "utf8")),
    instanceJson: sha256(path.join(dir, "control", "instance.json")),
    snapshots,
    log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "",
  };
}

/** Everything of the state but the log, which is expected to grow. */
const withoutLog = (state: InstallationState) => ({
  manifest: state.manifest,
  instance: state.instance,
  integrity: state.integrity,
  foreignKeys: state.foreignKeys,
  gate: state.gate,
  instanceJson: state.instanceJson,
  snapshots: state.snapshots,
});
const lines = (log: string): string[] => log.split("\n").filter((line) => line !== "");

async function waitHealthy(port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-persistence-"));
const evidence: Record<string, unknown> = {};
let instance: ComposeInstance | undefined;
try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const port = await freeLoopbackPort();
    const prepared = prepareComposeInstance(path.join(root, "installation"), { image: IMAGE, port });
    instance = prepared;
    const redact = (value: string): string => prepared.secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), value);
    const compose = (args: readonly string[], timeoutMs = 120_000) => {
      const result = docker(["compose", ...args], prepared.dir, timeoutMs);
      return { status: result.status, output: redact(result.output) };
    };
    const containerId = (): string => docker(["compose", "ps", "--all", "--quiet", "app"], prepared.dir).output.trim();
    const request = async (label: string): Promise<void> => {
      for (let index = 0; index < REQUESTS_PER_START; index += 1) await fetch(`http://127.0.0.1:${port}/api/${label}-${index}`);
      // The log sink drains in a later turn of the event loop.
      await new Promise((resolve) => setTimeout(resolve, 400));
    };
    /** The last ready event of the container: an existing installation, not a created one. */
    const lastReady = (): JsonObject => {
      const entries = compose(["logs", "--no-color", "app"]).output.split("\n").filter((line) => line.includes('"event":"bootstrap.ready"'));
      const json = /\{.*\}/.exec(entries.at(-1) ?? "")?.[0] ?? "{}";
      return object(JSON.parse(json));
    };

    // ---- First start: the installation is created and used; then stopped so it can be read.
    const first = compose(["up", "--detach", "--wait", "--wait-timeout", "90"], 150_000);
    check.expect(first.status === 0, "docker compose up --wait: the first start succeeds", first.output);
    await request("first");
    check.expect(compose(["stop"]).status === 0, "docker compose stop");
    const created = readState(prepared.dir);
    evidence["created"] = withoutLog(created);
    check.expect(
      Array.isArray(created.manifest) && created.manifest.length === 1 && text(created.gate) === '{"formatVersion":1,"generation":1,"activeOperation":null}',
      "the first start created one migration and a closed init operation",
      text(withoutLog(created)),
    );
    check.expect(
      text(created.instance).includes(prepared.instanceId) && created.integrity === "ok" && text(created.foreignKeys) === "[]",
      "the database carries the installation ID of instance.json and passes its checks",
    );
    check.expect(lines(created.log).length >= REQUESTS_PER_START && created.snapshots.length === 0, "the log has the requests, there is no snapshot yet", String(lines(created.log).length));

    // ---- A finished snapshot, made by a one-off container of the installation.
    const taken = compose(
      ["run", "--rm", "--no-deps", "--volume", `${SNAPSHOT_SCRIPT}:/script/create-snapshot.mjs:ro`, "--entrypoint", "node", "app", "/script/create-snapshot.mjs"],
      150_000,
    );
    check.expect(taken.status === 0 && taken.output.includes('"event":"snapshot.created"'), "a one-off container makes a database snapshot through the real adapter", taken.output);
    const baseline = readState(prepared.dir);
    evidence["baseline"] = withoutLog(baseline);
    check.expect(
      baseline.snapshots.length === 1 && baseline.snapshots[0]?.verified === true,
      "a finished snapshot is published in data/backup and verifies",
      text(baseline.snapshots),
    );
    check.expect(
      text({ ...withoutLog(baseline), snapshots: [] }) === text({ ...withoutLog(created), snapshots: [] }),
      "making the snapshot changed neither the manifest, the identity, the gate nor instance.json",
    );

    // ---- AC1: restart, restart, down/up. After each the app is stopped and the files are read again.
    const ids: string[] = [];
    let previousLog = baseline.log;
    const actions: ReadonlyArray<readonly [string, () => { status: number | null; output: string }]> = [
      ["restart 1: start after a stop", () => compose(["start"])],
      ["restart 2: restart of the running container", () => compose(["restart", "--timeout", "30"], 150_000)],
      ["recreate: down, then up", () => (compose(["down", "--timeout", "30"], 90_000), compose(["up", "--detach", "--wait", "--wait-timeout", "90"], 150_000))],
    ];
    for (const [name, act] of actions) {
      const before = containerId();
      const result = act();
      check.expect(result.status === 0 && (await waitHealthy(port)), `${name}: the app is healthy again`, result.output);
      const after = containerId();
      ids.push(after);
      if (name.startsWith("recreate")) check.expect(after !== "" && after !== before, "down/up created a new container (the old one was removed)", `${before} → ${after}`);
      await request(name.split(":")[0]?.replace(/\s/g, "") ?? "x");
      const ready = lastReady();
      check.expect(
        text(ready["database"]) === '{"schemaVersion":1,"created":false}' && text(ready["maintenance"]) === '{"generation":1,"initialized":false}',
        `${name}: the app reports an existing installation, not a new one`,
        text({ database: ready["database"], maintenance: ready["maintenance"] }),
      );
      check.expect(compose(["stop"]).status === 0, `${name}: docker compose stop`);
      const state = readState(prepared.dir);
      check.expect(
        text(withoutLog(state)) === text(withoutLog(baseline)),
        `${name}: manifest, installation ID, gate, instance.json, the snapshot and the database checks are unchanged`,
        text({ now: withoutLog(state), baseline: withoutLog(baseline) }),
      );
      check.expect(state.snapshots[0]?.verified === true && text(state.snapshots) === text(baseline.snapshots), `${name}: the snapshot is byte for byte the same and verifies`);
      const grown = lines(state.log).slice(lines(previousLog).length);
      check.expect(
        state.log.startsWith(previousLog) && grown.length >= REQUESTS_PER_START && grown.every((line) => text(JSON.parse(line)).includes(prepared.instanceId)),
        `${name}: the log only grew, with lines of this installation`,
        `${grown.length} new lines`,
      );
      previousLog = state.log;
    }

    // ---- AC2: removing the container keeps the data; missing mounts create nothing.
    const stillThere = docker(["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${prepared.projectName}`], repoRoot).output.trim();
    compose(["down", "--timeout", "30"], 90_000);
    check.expect(docker(["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${prepared.projectName}`], repoRoot).output.trim() === "" && stillThere !== "", "docker compose down removes the container");
    check.expect(text(withoutLog(readState(prepared.dir))) === text(withoutLog(baseline)), "with the container removed, all the data is still there");

    const bareRun = (mounts: ContainerMounts): { status: number | null; output: string; diff: string } => {
      const name = `openlife-nomount-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const run = docker(["run", "--name", name, "--platform", platform, ...containerInstanceArgs(prepared, mounts), IMAGE], repoRoot, 60_000);
      const diff = docker(["diff", name], repoRoot).output;
      docker(["rm", "--force", name], repoRoot);
      return { status: run.status, output: redact(run.output), diff };
    };
    const dataBefore = { db: sha256(path.join(prepared.dir, "data", "app.db")), gate: sha256(path.join(prepared.dir, "control", "maintenance", "state.json")) };
    const missing: ReadonlyArray<readonly [string, ContainerMounts, string[]]> = [
      ["no data mount", { data: "none" }, ["data"]],
      ["no maintenance mount", { maintenance: "none" }, ["maintenance"]],
      ["no mount at all", { data: "none", maintenance: "none" }, ["data", "maintenance"]],
    ];
    for (const [name, mounts, fields] of missing) {
      const result = bareRun(mounts);
      const failed = result.output.split("\n").find((line) => line.includes('"bootstrap.failed"')) ?? "";
      check.expect(
        result.status === 1 && failed === text({ event: "bootstrap.failed", code: "STORAGE_NOT_MOUNTED", fields }),
        `${name}: the image refuses to start (STORAGE_NOT_MOUNTED ${fields.join(", ")})`,
        result.output,
      );
      check.expect(!result.output.includes('"bootstrap.ready"') && !result.output.includes('"server.listening"'), `${name}: it never reported ready or listening`);
      // /instance/instance.json is the mount point Docker adds for the file mount, not the app's doing.
      check.expect(!/app\.db|state\.json|writer\.lock|app\.jsonl|\/data|\/control/.test(result.diff), `${name}: nothing of an installation appeared in the container's own file system`, result.diff);
    }
    check.expect(
      sha256(path.join(prepared.dir, "data", "app.db")) === dataBefore.db && sha256(path.join(prepared.dir, "control", "maintenance", "state.json")) === dataBefore.gate,
      "the refused starts left the mounted database and gate untouched",
    );

    // Compose itself: a host folder that is gone is an error, not a folder created as root.
    const moved = path.join(prepared.dir, "data.moved");
    renameSync(path.join(prepared.dir, "data"), moved);
    const withoutData = compose(["up", "--detach"], 60_000);
    check.expect(withoutData.status !== 0 && /bind source path does not exist|no such file/i.test(withoutData.output), "docker compose up refuses a missing data folder", withoutData.output);
    check.expect(!existsSync(path.join(prepared.dir, "data")), "Compose did not create the missing data folder");
    compose(["down", "--timeout", "10"], 60_000);
    renameSync(moved, path.join(prepared.dir, "data"));
    const restored = compose(["up", "--detach", "--wait", "--wait-timeout", "90"], 150_000);
    check.expect(restored.status === 0 && (await waitHealthy(port)), "with the folder back the same installation starts again", restored.output);
    compose(["stop"]);
    check.expect(text(withoutLog(readState(prepared.dir))) === text(withoutLog(baseline)), "and it is still the same installation");
    evidence["containerIds"] = ids;
  }
} finally {
  if (instance) docker(["compose", "down", "--timeout", "10"], instance.dir);
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  rmSync(root, { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) writeFileSync(path.join(evidenceDir, `compose-persistence-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
check.finish();
