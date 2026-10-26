// D07.3 — two Compose installations A and B on one host, on this host's native architecture, and
// what happens when something tries to share their storage or port (Architektura §4.8, §12.1,
// §14.5, §15.1; Scope NF-01/NF-02; AR11).
// AC1: A and B have different installation IDs, Compose projects, keys, ports, folders, databases
//      and logs, checked on the files, on the running containers and through `paths`; a request
//      on a port lands only in the log of its own installation; restarting and recreating A
//      leaves B running, answering and byte for byte unchanged.
// AC2: a third app on A's data and control folders (a one-off container of A's project, and a
//      container of another installation mounting A's folders) is refused with INSTANCE_BUSY and
//      changes nothing; an installation whose port is taken does not start and neither touches A
//      nor creates its own installation state. Sessions and cookies of A/B stay not_run until D09.
// Compose output holds the installation keys, so nothing from it is printed unredacted.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { VERSION } from "../support/migration-plans.ts";
import { freeLoopbackPort, prepareComposeInstance, type ComposeInstance } from "../support/compose-instance.ts";
import { buildAppImage, containerInstanceArgs, docker, requireNativeDocker } from "../support/docker.ts";
import {
  lastComposeEvent,
  logLines,
  readInstallationState,
  readLog,
  sha256,
  waitHealthy,
  withoutLog,
  type InstallationState,
} from "../support/installation-state.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { outputEvent } from "../support/server-process.ts";
import { prepareTestInstance } from "../support/test-instance.ts";

const IMAGE = "openlife-app:verify-d07-isolation";
const READY_TIMEOUT_MS = 90_000;
const UP = ["up", "--detach", "--wait", "--wait-timeout", "90"] as const;
/** Different request counts on A and B, so the log of each shows where the requests went. */
const REQUESTS = { a: 3, b: 5 } as const;
const PROBE_INTERVAL_MS = 250;
/** The file sink drains in a later turn of the event loop. */
const LOG_DRAIN_MS = 400;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`two Compose installations and their collisions on ${platform}`);
if (docker(["compose", "version", "--short"], repoRoot).status !== 0) {
  check.expect(false, "the docker compose plugin is available");
  check.finish();
  process.exit(process.exitCode ?? 1);
}

const text = (value: unknown): string => JSON.stringify(value);
const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Result = Readonly<{ status: number | null; output: string }>;

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-isolation-"));
const prepared: ComposeInstance[] = [];
/** Keys of test installations that never become a Compose project, redacted all the same. */
const otherSecrets: string[] = [];
const evidence: Record<string, unknown> = { sessionsAndCookies: "not_run until D09 (DEV D07.3-AC2)" };
try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const portA = await freeLoopbackPort();
    let portB = await freeLoopbackPort();
    while (portB === portA) portB = await freeLoopbackPort();
    const a = prepareComposeInstance(path.join(root, "installation a"), { image: IMAGE, port: portA });
    prepared.push(a);
    const b = prepareComposeInstance(path.join(root, "installation b"), { image: IMAGE, port: portB });
    prepared.push(b);
    const allSecrets = (): string[] => [...prepared.flatMap((instance) => instance.secrets), ...otherSecrets];
    const redact = (value: string): string => allSecrets().reduce((out, secret) => out.split(secret).join("[redacted]"), value);
    const compose = (instance: ComposeInstance, args: readonly string[], timeoutMs = 150_000): Result => {
      const result = docker(["compose", ...args], instance.dir, timeoutMs);
      return { status: result.status, output: redact(result.output) };
    };
    /** Compose without blocking the event loop, so another installation can be probed meanwhile. */
    const composeAsync = (instance: ComposeInstance, args: readonly string[]): Promise<Result> =>
      new Promise((resolve) => {
        const child = spawn("docker", ["compose", ...args], { cwd: instance.dir });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.on("close", (status) => resolve({ status, output: redact(output) }));
      });
    const containerId = (instance: ComposeInstance): string => docker(["compose", "ps", "--all", "--quiet", "app"], instance.dir).output.trim();
    const inspect = (id: string): JsonObject => {
      const result = id === "" ? undefined : docker(["inspect", id], repoRoot);
      return result?.status === 0 ? object(list(JSON.parse(result.output))[0]) : {};
    };
    const request = async (port: number, count: number): Promise<void> => {
      for (let index = 0; index < count; index += 1) await fetch(`http://127.0.0.1:${port}/api/isolation-${index}`);
      await pause(LOG_DRAIN_MS);
    };
    const requestLines = (log: string): string[] => logLines(log).filter((line) => line.includes('"event":"http.request"'));
    /** Every line of the log belongs to `own` and none mentions `other`. */
    const logOf = (log: string, own: ComposeInstance, other: ComposeInstance): boolean =>
      logLines(log).every((line) => line.includes(own.instanceId) && !line.includes(other.instanceId));

    // ---- AC1, prepared files: two installations with nothing in common.
    check.expect(a.instanceId !== b.instanceId, "A and B have different installation IDs");
    check.expect(a.projectName !== b.projectName, "A and B are different Compose projects", `${a.projectName} / ${b.projectName}`);
    check.expect(a.port !== b.port, "A and B publish different host ports", `${a.port} / ${b.port}`);
    check.expect(a.secrets.length === 2 && a.secrets.every((secret) => !b.secrets.includes(secret)), "A and B have their own keys, none shared");
    evidence["installations"] = prepared.map((instance) => ({ instanceId: instance.instanceId, project: instance.projectName, port: instance.port }));

    // ---- AC1, running: both up, each container carries only its own installation.
    const upA = compose(a, UP);
    const upB = compose(b, UP);
    if (check.expect(upA.status === 0 && upB.status === 0, "docker compose up --wait: A and B are healthy side by side", `${upA.output}\n${upB.output}`)) {
      for (const [own, other] of [[a, b], [b, a]] as const) {
        const name = own === a ? "A" : "B";
        const inspected = inspect(containerId(own));
        const labels = object(object(inspected["Config"])["Labels"]);
        check.expect(labels["com.docker.compose.project"] === own.projectName, `${name}: the container belongs to its own project`, String(labels["com.docker.compose.project"]));
        const environment = list(object(inspected["Config"])["Env"]).map(String);
        check.expect(
          own.secrets.every((secret) => environment.some((entry) => entry.endsWith(`=${secret}`))) && !other.secrets.some((secret) => environment.some((entry) => entry.includes(secret))),
          `${name}: the container has its own keys and none of the other installation`,
        );
        const sources = list(inspected["Mounts"]).map((mount) => String(object(mount)["Source"]));
        check.expect(
          sources.length === 3 && sources.every((source) => source.startsWith(`${own.dir}${path.sep}`)),
          `${name}: all three mounts come from its own installation folder`,
          sources.join(", "),
        );
        const bindings = list(object(object(object(inspected["NetworkSettings"])["Ports"]))["8080/tcp"]).map(object);
        check.expect(
          bindings.length === 1 && bindings[0]?.["HostIp"] === "127.0.0.1" && bindings[0]?.["HostPort"] === String(own.port),
          `${name}: published on 127.0.0.1:${own.port} only`,
          text(bindings),
        );
        const paths = compose(own, ["run", "--rm", "--no-deps", "--entrypoint", "node", "app", "apps/server/dist/cli/paths.js"]);
        const described = outputEvent(paths.output, "paths");
        const host = object(described?.["host"]);
        check.expect(
          paths.status === 0 && described?.["instanceId"] === own.instanceId && host["database"] === path.join(own.dir, "data", "app.db") && host["logs"] === path.join(own.dir, "data", "logs", "app"),
          `${name}: paths in its own container names its installation ID, database and log folder`,
          paths.output,
        );
      }

      // A request on a port lands in the log of that installation only.
      await request(a.port, REQUESTS.a);
      await request(b.port, REQUESTS.b);
      const logA = readLog(a.dir);
      const logB = readLog(b.dir);
      check.expect(requestLines(logA).length === REQUESTS.a && logOf(logA, a, b), `A's log has its ${REQUESTS.a} requests, all with A's ID and none of B's`, String(requestLines(logA).length));
      check.expect(requestLines(logB).length === REQUESTS.b && logOf(logB, b, a), `B's log has its ${REQUESTS.b} requests, all with B's ID and none of A's`, String(requestLines(logB).length));

      // B's baseline, read from its files while it is stopped; then B runs while A is restarted.
      check.expect(compose(b, ["stop"]).status === 0, "B: docker compose stop for the baseline read");
      const baselineB = readInstallationState(b.dir);
      check.expect(
        text(baselineB.instance).includes(b.instanceId) && !text(baselineB.instance).includes(a.instanceId) && baselineB.integrity === "ok",
        "B's database carries B's installation ID only",
        text(withoutLog(baselineB)),
      );
      check.expect(compose(b, ["start"]).status === 0 && (await waitHealthy(b.port, READY_TIMEOUT_MS)), "B is healthy again");
      await pause(LOG_DRAIN_MS);
      const runningB = { id: containerId(b), startedAt: object(inspect(containerId(b))["State"])["StartedAt"], log: readLog(b.dir) };

      // ---- AC1: restart and recreate A; B is probed all the while.
      const probes = { answered: 0, failed: 0 };
      let probing = true;
      const prober = (async () => {
        while (probing) {
          try {
            const health = await fetch(`http://127.0.0.1:${b.port}/api/health`);
            probes[health.status === 200 ? "answered" : "failed"] += 1;
          } catch {
            probes.failed += 1;
          }
          await pause(PROBE_INTERVAL_MS);
        }
      })();
      const idBefore = containerId(a);
      const restart = await composeAsync(a, ["restart", "--timeout", "30"]);
      const restartHealthy = restart.status === 0 && (await waitHealthy(a.port, READY_TIMEOUT_MS));
      const down = await composeAsync(a, ["down", "--timeout", "30"]);
      const up = await composeAsync(a, UP);
      const recreateHealthy = down.status === 0 && up.status === 0 && (await waitHealthy(a.port, READY_TIMEOUT_MS));
      probing = false;
      await prober;
      evidence["probesOfBWhileARestarted"] = probes;
      check.expect(restartHealthy, "A: docker compose restart, healthy again", restart.output);
      check.expect(recreateHealthy && containerId(a) !== idBefore, "A: down/up created a new container, healthy again", `${down.output}\n${up.output}`);
      const readyA = lastComposeEvent(compose(a, ["logs", "--no-color", "app"]).output, "bootstrap.ready");
      check.expect(text(readyA["database"]) === JSON.stringify({ schemaVersion: VERSION.a, created: false }), "A after down/up is its existing installation, not a new one", text(readyA));
      check.expect(probes.answered > 0 && probes.failed === 0, `B answered every health probe while A was restarted (${probes.answered}/${probes.answered + probes.failed})`);
      const stateB = object(inspect(containerId(b))["State"]);
      check.expect(
        containerId(b) === runningB.id && stateB["StartedAt"] === runningB.startedAt && stateB["Running"] === true,
        "B kept the same running container, never restarted",
        text({ before: runningB, now: { id: containerId(b), startedAt: stateB["StartedAt"] } }),
      );
      check.expect(readLog(b.dir) === runningB.log, "nothing was written to B's log while A was restarted");

      // ---- AC2: a third app on A's data and control folders, while A runs.
      await request(a.port, 1);
      const lockA = path.join(a.dir, "control", "maintenance", "writer.lock");
      const filesA = { lockInode: statSync(lockA).ino, gate: sha256(path.join(a.dir, "control", "maintenance", "state.json")), instanceJson: sha256(a.instanceFile), id: containerId(a), log: readLog(a.dir) };
      const third = (label: string, result: Result): void => {
        const failed = outputEvent(result.output, "bootstrap.failed");
        evidence[`third app: ${label}`] = failed;
        check.expect(
          result.status === 1 && text(failed) === text({ event: "bootstrap.failed", code: "INSTANCE_BUSY", fields: ["writer.lock"] }),
          `${label}: refused with INSTANCE_BUSY [writer.lock]`,
          result.output,
        );
        check.expect(!result.output.includes('"server.listening"') && !result.output.includes('"bootstrap.ready"'), `${label}: never ready, never listening`);
      };
      // A one-off container of A's own project: what `docker compose run app` would start.
      third("a one-off container of A's project", compose(a, ["run", "--rm", "--no-deps", "app"]));
      // Another installation's container pointed at A's folders: its own keys and instance.json.
      const stray = prepareTestInstance(path.join(root, "stray"));
      otherSecrets.push(...stray.secrets);
      const strayRun = docker(["run", "--rm", "--platform", platform, ...containerInstanceArgs({ ...stray, dir: a.dir }), IMAGE], repoRoot, 60_000);
      third("a container of another installation mounting A's folders", { status: strayRun.status, output: redact(strayRun.output) });
      check.expect(
        statSync(lockA).ino === filesA.lockInode &&
          sha256(path.join(a.dir, "control", "maintenance", "state.json")) === filesA.gate &&
          sha256(a.instanceFile) === filesA.instanceJson &&
          containerId(a) === filesA.id &&
          readLog(a.dir) === filesA.log &&
          (await waitHealthy(a.port, 5_000)),
        "A kept its lock file, gate, instance.json, log and running container",
      );

      // ---- AC2: an installation whose host port is taken by A.
      const clash = prepareComposeInstance(path.join(root, "installation c"), { image: IMAGE, port: a.port });
      prepared.push(clash);
      const logABefore = readLog(a.dir);
      const clashUp = compose(clash, ["up", "--detach"], 120_000);
      check.expect(clashUp.status !== 0 && /port is already allocated|address already in use/i.test(clashUp.output), "C on A's port: docker compose up fails on the taken port", clashUp.output);
      const clashState = object(inspect(containerId(clash))["State"]);
      check.expect(clashState["Running"] !== true, "C's container is not running", text(clashState));
      check.expect(
        !existsSync(path.join(clash.dir, "data", "app.db")) &&
          !existsSync(path.join(clash.dir, "control", "maintenance", "state.json")) &&
          readdirSync(path.join(clash.dir, "data", "logs", "app")).length === 0,
        "C created no database, gate or log: no half-made installation",
      );
      await request(a.port, 1);
      const logAAfter = readLog(a.dir);
      check.expect(
        containerId(a) === filesA.id && logAAfter.startsWith(logABefore) && requestLines(logAAfter.slice(logABefore.length)).length === 1 && logOf(logAAfter, a, b) && logOf(logAAfter, a, clash),
        "A's port still reaches A: the request is in A's log, with A's ID only",
      );
      compose(clash, ["down", "--timeout", "10"], 60_000);

      // ---- Final read of both installations from their files, with both stopped.
      check.expect(compose(a, ["stop"]).status === 0 && compose(b, ["stop"]).status === 0, "docker compose stop of A and B");
      const finalA: InstallationState = readInstallationState(a.dir);
      const finalB: InstallationState = readInstallationState(b.dir);
      evidence["final"] = { a: withoutLog(finalA), b: withoutLog(finalB) };
      check.expect(
        text(finalA.instance).includes(a.instanceId) && !text(finalA.instance).includes(b.instanceId) && finalA.integrity === "ok" && text(finalA.gate) === '{"formatVersion":1,"generation":1,"activeOperation":null}',
        "A's database still has A's ID, passes its checks, and its gate saw only its own init",
        text(withoutLog(finalA)),
      );
      check.expect(text(withoutLog(finalB)) === text(withoutLog(baselineB)), "B's manifest, ID, gate, instance.json and database checks are exactly the baseline", text({ now: withoutLog(finalB), baseline: withoutLog(baselineB) }));
      check.expect(finalB.log.startsWith(baselineB.log) && logOf(finalB.log, b, a), "B's log only grew, with B's own lines");
      check.expect(logOf(finalA.log, a, b), "A's log has only A's lines");
    }
  }
} finally {
  for (const instance of prepared) docker(["compose", "down", "--timeout", "10"], instance.dir, 60_000);
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  rmSync(root, { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) writeFileSync(path.join(evidenceDir, `compose-isolation-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
check.finish();
