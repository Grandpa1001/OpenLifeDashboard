// D07.1 — the real Docker Compose run of the local mode, on this host's native architecture:
// the files of docker/ are copied into a fresh test installation by the preparer, the image is
// pinned by the release override, and the services are started and stopped from the
// installation folder like a user would. Checked on the running container, not on the files:
// non-root (and files created with the host user), only 127.0.0.1:PORT→8080 published and not
// reachable on another address, healthcheck through Node healthy on a 200, the three mounts of
// §15.1 and nothing else (no Docker socket, no whole control folder), only the needed variables,
// no Caddy/updater/token needed, stop within the 20 s grace with the orderly stop in the log.
// Compose output holds the installation keys, so nothing from it is printed unredacted.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { prepareComposeInstance } from "../support/compose-instance.ts";
import { buildAppImage, docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-d07-compose";
const READY_TIMEOUT_S = 90;
const OPTIONAL_OPTION = { key: "DB_BUSY_TIMEOUT_MS", value: "7000" } as const;
const SECRET_PROBE = "UPDATER_TOKEN";
const SECRET_PROBE_VALUE = "d07-must-not-reach-the-container";

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`Docker Compose local mode on ${platform}`);

const probe = docker(["compose", "version", "--short"], repoRoot);
if (probe.status !== 0) {
  check.expect(false, "the docker compose plugin is available", probe.output);
  check.finish();
  process.exit(process.exitCode ?? 1);
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

async function refusedOn(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3000 });
    socket.once("connect", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(true));
    socket.once("timeout", () => (socket.destroy(), resolve(true)));
  });
}

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-compose-"));
const evidence: Record<string, unknown> = {};
let instanceDir: string | undefined;
try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const port = await freePort();
    const instance = prepareComposeInstance(path.join(root, "installation"), {
      image: IMAGE,
      port,
      extraEnv: { [OPTIONAL_OPTION.key]: OPTIONAL_OPTION.value, [SECRET_PROBE]: SECRET_PROBE_VALUE },
    });
    instanceDir = instance.dir;
    const redact = (text: string): string => [...instance.secrets, SECRET_PROBE_VALUE].reduce((out, secret) => out.split(secret).join("[redacted]"), text);
    const compose = (args: readonly string[], timeoutMs?: number) => {
      const result = docker(["compose", ...args], instance.dir, timeoutMs);
      return { status: result.status, output: redact(result.output) };
    };

    // The configuration, as Compose merges it: one service, the pinned local image, no registry.
    const config = compose(["config", "--format", "json"]);
    check.expect(config.status === 0, "docker compose config succeeds with no Caddy/updater/token variables", config.output);
    const merged = object(JSON.parse(docker(["compose", "config", "--format", "json"], instance.dir).output));
    const services = object(merged["services"]);
    check.expect(JSON.stringify(Object.keys(services)) === '["app"]', "the project has one service: app", Object.keys(services).join(","));
    check.expect(object(services["app"])["image"] === IMAGE, "the release override pins the image that exists on this host");
    check.expect(merged["name"] === instance.projectName, "the project is named after this installation", String(merged["name"]));

    // A missing required variable is a clear error naming it, not a silent default.
    const brokenDir = path.join(root, "broken");
    const broken = prepareComposeInstance(brokenDir, { image: IMAGE, port: await freePort() });
    const envText = readFileSync(broken.envFile, "utf8").split("\n").filter((line) => !line.startsWith("BETTER_AUTH_SECRET=")).join("\n");
    writeFileSync(broken.envFile, envText);
    const refused = docker(["compose", "config"], brokenDir);
    check.expect(refused.status !== 0 && refused.output.includes("BETTER_AUTH_SECRET"), "a missing BETTER_AUTH_SECRET stops compose and names the variable", redact(refused.output));

    // Start and wait for the healthcheck.
    const up = compose(["up", "--detach", "--wait", "--wait-timeout", String(READY_TIMEOUT_S)], (READY_TIMEOUT_S + 30) * 1000);
    if (check.expect(up.status === 0, "docker compose up --wait: the service becomes healthy", up.output)) {
      const id = docker(["compose", "ps", "--quiet", "app"], instance.dir).output.trim();
      const inspected = object(list(JSON.parse(docker(["inspect", id], repoRoot).output))[0]);
      const state = object(inspected["State"]);
      const hostConfig = object(inspected["HostConfig"]);
      const containerConfig = object(inspected["Config"]);
      check.expect(state["Status"] === "running" && object(state["Health"])["Status"] === "healthy", "the container is running and healthy", JSON.stringify(state));

      // Non-root, with the files of the installation owned by the host user.
      const uid = docker(["compose", "exec", "-T", "app", "id", "-u"], instance.dir).output.trim();
      check.expect(uid !== "" && uid !== "0" && uid === String(process.getuid?.() ?? uid), `the app runs as the host user, not root (uid ${uid})`);
      const dbOwner = statSync(path.join(instance.dir, "data", "app.db")).uid;
      check.expect(dbOwner === process.getuid?.(), "data/app.db was created with the host user's ownership", String(dbOwner));
      check.expect(
        readdirSync(path.join(instance.dir, "data", "logs", "app")).includes("app.jsonl"),
        "the technical log is written to data/logs/app through the mount",
      );

      // The published port: loopback only.
      const bindings = object(object(object(inspected["NetworkSettings"])["Ports"]));
      const published = list(bindings["8080/tcp"]).map((entry) => object(entry));
      check.expect(
        Object.keys(bindings).length === 1 && published.length === 1 && published[0]?.["HostIp"] === "127.0.0.1" && published[0]?.["HostPort"] === String(port),
        "exactly 127.0.0.1:PORT→8080 is published",
        JSON.stringify(bindings),
      );
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      check.expect(health.status === 200 && (await health.text()) === '{"status":"ok"}', "GET /api/health on the loopback address answers 200 ok");
      const external = Object.values(os.networkInterfaces())
        .flat()
        .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
      if (external) {
        check.expect(await refusedOn(external.address, port), `the port is not reachable on the host's other address ${external.address}`);
      }

      // Healthcheck, mounts, privileges, environment.
      const healthcheck = object(containerConfig["Healthcheck"]);
      check.expect(
        list(healthcheck["Test"]).slice(0, 3).join(" ") === "CMD node -e" && String(list(healthcheck["Test"])[3]).includes("/api/health"),
        "the healthcheck runs node against /api/health",
        JSON.stringify(healthcheck),
      );
      const mounts = list(inspected["Mounts"]).map((entry) => object(entry));
      const mountSummary = mounts.map((mount) => `${String(mount["Type"])}:${String(mount["Destination"])}:${mount["RW"] === true ? "rw" : "ro"}`).sort();
      check.expect(
        JSON.stringify(mountSummary) === JSON.stringify(["bind:/control/maintenance:rw", "bind:/data:rw", "bind:/instance/instance.json:ro"]),
        "the app has exactly the three mounts of §15.1: data, maintenance (rw), instance.json (ro)",
        mountSummary.join(", "),
      );
      check.expect(!JSON.stringify(inspected).includes("docker.sock"), "no Docker socket anywhere in the container's configuration");
      check.expect(
        hostConfig["Privileged"] === false && hostConfig["ReadonlyRootfs"] === true && JSON.stringify(hostConfig["CapDrop"]) === '["ALL"]' && JSON.stringify(hostConfig["SecurityOpt"]) === '["no-new-privileges:true"]',
        "not privileged, read-only root file system, all capabilities dropped, no-new-privileges",
        JSON.stringify({ Privileged: hostConfig["Privileged"], ReadonlyRootfs: hostConfig["ReadonlyRootfs"], CapDrop: hostConfig["CapDrop"] }),
      );
      check.expect(containerConfig["StopTimeout"] === 20, "stop_grace_period is 20 s", String(containerConfig["StopTimeout"]));
      const environment = list(containerConfig["Env"]).map(String);
      const keys = environment.map((entry) => entry.split("=")[0]);
      check.expect(!keys.includes(SECRET_PROBE) && !keys.includes("RELEASES_REPO"), "a token in .env does not reach the app: only listed variables are passed", keys.join(","));
      check.expect(environment.includes(`${OPTIONAL_OPTION.key}=${OPTIONAL_OPTION.value}`), "an optional option set in .env reaches the app (pass-through)", keys.join(","));
      check.expect(!keys.includes("PORT") && !keys.includes("COMPOSE_FILE") && !keys.includes("APP_UID"), "installation keys that are only for Compose stay out of the container", keys.join(","));

      // Stop: orderly, inside the grace period.
      const stopStarted = Date.now();
      const stop = compose(["stop"], 60_000);
      const stopSeconds = (Date.now() - stopStarted) / 1000;
      const after = object(list(JSON.parse(docker(["inspect", id], repoRoot).output))[0]);
      const logs = compose(["logs", "--no-color", "app"]).output;
      check.expect(stop.status === 0 && object(after["State"])["ExitCode"] === 0, "docker compose stop ends the app with exit code 0", JSON.stringify(object(after["State"])));
      check.expect(stopSeconds < 20, `the stop took ${stopSeconds.toFixed(1)} s, inside the 20 s grace period`);
      check.expect(logs.includes('"event":"server.stopped"') && logs.includes('"step":"lease"'), "the log shows the orderly stop up to the lease", logs);
      check.expect(![...instance.secrets, SECRET_PROBE_VALUE].some((secret) => logs.includes(secret)), "the container log holds no installation secret");
      evidence["summary"] = { uid, mounts: mountSummary, bindings, stopSeconds, healthStatus: object(state["Health"])["Status"] };
    }
    compose(["down", "--timeout", "30"], 90_000);
  }
} finally {
  if (instanceDir) docker(["compose", "down", "--timeout", "10"], instanceDir);
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  rmSync(root, { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, `compose-local-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
