// D52.5 — the updater as a service of Compose on a real daemon (Architektura §11.2.1, §12.1): the image of the
// `updater` target and the file compose.updater.yml, pinned by digest through the release file, next to the app. The
// service is hardened and holds only what it needs (the socket, the control folder, the backups read-only, the token and
// the name of its project, none of the keys of the app), answers the signed commands over its internal port, keeps its
// journal in the control folder of the installation as the host user's file, keeps the fence across a restart and refuses
// the commands older than the process, looks at the app of its own project only (a second installation runs beside it),
// writes no token, signature or nonce to its log, and does not start without a token of the right shape.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_SIGNATURE_HEADER, type UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort, prepareComposeInstance, type ComposeInstance } from "../support/compose-instance.ts";
import { docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { signCommand } from "../../apps/updater/dist/protocol/verify-command.js";
import { writeReleaseFile } from "../../apps/updater/dist/release/release-file.js";

const { platform } = requireNativeDocker(repoRoot);
const check = createCheck(`the updater as a service of Compose on ${platform}`);
const APP_TAG = "openlife-app:updater-service";
const UPDATER_TAG = "openlife-updater:updater-service";
const TOKEN = randomBytes(32).toString("hex");

const run = (args: readonly string[], cwd = repoRoot, input?: string) => {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
};
const probe = docker(["compose", "version", "--short"], repoRoot);
if (probe.status !== 0) {
  check.expect(false, "the docker compose plugin is available", probe.output);
  check.finish();
  process.exit(process.exitCode ?? 1);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const inspectOf = (id: string): Record<string, any> => JSON.parse(run(["inspect", id]).stdout)[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function healthy(id: string, seconds = 90): Promise<boolean> {
  for (let waited = 0; waited < seconds; waited += 1) {
    const state = inspectOf(id)["State"] as { Running: boolean; Health?: { Status: string } };
    if (state.Running && state.Health?.Status === "healthy") return true;
    await sleep(1000);
  }
  return false;
}

/** What a client in the network of the installation would send: the command signed on the host, sent from inside the service. */
function send(instance: ComposeInstance, envelope: UpdaterEnvelope, over: { signature?: string } = {}): { status: number; json: Record<string, unknown> } {
  const body = JSON.stringify(envelope);
  const signature = over.signature ?? signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body });
  const script = `let input='';process.stdin.on('data',(c)=>input+=c).on('end',async()=>{const {body,signature}=JSON.parse(input);const r=await fetch('http://127.0.0.1:9090${UPDATER_COMMAND_PATH}',{method:'POST',headers:{'content-type':'application/json','${UPDATER_SIGNATURE_HEADER}':signature},body});console.log(JSON.stringify({status:r.status,json:await r.json()}));});`;
  const result = run(["compose", "exec", "-T", "updater", "node", "-e", script], instance.dir, JSON.stringify({ body, signature }));
  const line = result.stdout.trim().split("\n").at(-1) ?? "{}";
  try {
    return JSON.parse(line) as { status: number; json: Record<string, unknown> };
  } catch {
    return { status: 0, json: { raw: result.output.slice(0, 200) } };
  }
}
const envelopeOf = (command: UpdaterEnvelope["command"], issuedAt = Date.now()): UpdaterEnvelope => ({ v: 1, operationId: randomUUID(), issuedAt, nonce: randomBytes(24).toString("base64url"), command });

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-updater-service-"));
const registryName = `openlife-registry-svc-${process.pid}`;
let x: ComposeInstance | undefined;
let y: ComposeInstance | undefined;
try {
  const appBuild = docker(["build", "--platform", platform, "-f", "docker/Dockerfile", "-t", APP_TAG, "."], repoRoot, 15 * 60 * 1000);
  check.expect(appBuild.status === 0, "docker build of the app image exits 0", appBuild.output);
  const updaterBuild = docker(["build", "--platform", platform, "-f", "docker/Dockerfile", "--target", "updater", "-t", UPDATER_TAG, "."], repoRoot, 15 * 60 * 1000);
  check.expect(updaterBuild.status === 0, "docker build --target updater exits 0", updaterBuild.output);
  const registryPort = await freeLoopbackPort();
  check.expect(run(["run", "-d", "--name", registryName, "-p", `127.0.0.1:${registryPort}:5000`, "registry:2"]).status === 0, "a local registry is running for the digests");
  await sleep(2000);
  const pins: Record<string, { repository: string; digest: string }> = {};
  for (const [tag, name] of [[APP_TAG, "openlife-app"], [UPDATER_TAG, "openlife-updater"]] as const) {
    const repository = `localhost:${registryPort}/${name}`;
    run(["tag", tag, `${repository}:t`]);
    check.expect(run(["push", `${repository}:t`]).status === 0, `${name} is pushed to the registry`);
    pins[name] = { repository, digest: run(["inspect", "--format", "{{index .RepoDigests 0}}", `${repository}:t`]).stdout.trim().split("@")[1] ?? "" };
  }

  // The group of the socket, which the installer writes from the host (D61): on Linux the daemon is on this very socket and its group is
  // the one the service must have to reach it (run 43844052201, where the group 0 of Docker Desktop could not); on Docker Desktop the
  // socket the service sees lies inside the virtual machine and belongs to the group 0.
  const dockerGid = process.platform === "linux" ? String(statSync("/var/run/docker.sock").gid) : "0";
  x = prepareComposeInstance(path.join(root, "x"), { image: APP_TAG, port: await freeLoopbackPort(), updater: { token: TOKEN, releasesRepo: "example/openlife-releases", dockerGid } });
  y = prepareComposeInstance(path.join(root, "y"), { image: APP_TAG, port: await freeLoopbackPort() });
  const writtenX = writeReleaseFile(path.join(x.dir, "control"), { app: pins["openlife-app"]!, updater: pins["openlife-updater"]! });
  const writtenY = writeReleaseFile(path.join(y.dir, "control"), { app: pins["openlife-app"]!, updater: null });
  check.expect(writtenX.ok && writtenY.ok, "the release files pin the images of the app and of the updater by digest");
  const compose = (instance: ComposeInstance, ...args: string[]) => run(["compose", ...args], instance.dir);
  check.expect(compose(x, "up", "-d", "--wait", "--wait-timeout", "120").status === 0, "installation X with the updater is up: the app accepts UPDATER_ENABLED=true and both are healthy");
  check.expect(compose(y, "up", "-d", "--wait", "--wait-timeout", "120").status === 0, "installation Y without the updater is up beside it");
  const idOf = (instance: ComposeInstance, service: string): string => compose(instance, "ps", "-q", service).stdout.trim();
  const updaterId = idOf(x, "updater");
  const appId = idOf(x, "app");

  // The service as Compose made it.
  const u = inspectOf(updaterId);
  const mounts = (u["Mounts"] as Array<{ Source: string; Destination: string; RW: boolean }>).map((mount) => `${mount.Destination}:${mount.RW ? "rw" : "ro"}`).sort();
  check.expect(String(u["Config"].Image).includes(pins["openlife-updater"]!.digest) && /^\d+:\d+$/.test(String(u["Config"].User)) && !String(u["Config"].User).startsWith("0:"), "the updater is the image pinned by its digest and runs as the host user, not as root");
  check.expect(u["HostConfig"].ReadonlyRootfs === true && JSON.stringify(u["HostConfig"].CapDrop) === '["ALL"]' && JSON.stringify(u["HostConfig"].SecurityOpt) === '["no-new-privileges:true"]', "the root file system is read only, no capability is kept and no new privilege is allowed");
  check.expect(Object.keys(u["NetworkSettings"].Ports ?? {}).every((port) => (u["NetworkSettings"].Ports[port] ?? null) === null) && Object.keys(u["HostConfig"].PortBindings ?? {}).length === 0, "the updater publishes no port");
  check.expect(JSON.stringify(mounts) === JSON.stringify(["/backup:ro", "/control:rw", "/var/run/docker.sock:rw"]), "the updater holds the socket, the control folder and the backups read-only, and nothing else", JSON.stringify(mounts));
  const updaterEnv = (u["Config"].Env as string[]).map((entry) => entry.split("=")[0]);
  check.expect(updaterEnv.includes("UPDATER_TOKEN") && updaterEnv.includes("COMPOSE_PROJECT_NAME") && !["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "BASE_URL", "INSTALL_MODE"].some((key) => updaterEnv.includes(key)), "the updater has its token and its project and none of the keys of the app");
  const a = inspectOf(appId);
  check.expect(!(a["Mounts"] as Array<{ Source: string }>).some((mount) => /docker\.sock|control$/.test(mount.Source)) && (a["Config"].Env as string[]).some((entry) => entry.startsWith("UPDATER_TOKEN=")) && (a["Config"].Env as string[]).some((entry) => entry === "UPDATER_ENABLED=true"), "the app has the token and the flag, and neither the socket nor the control folder");

  // The channel.
  const status = send(x, envelopeOf({ type: "status" }));
  check.expect(status.status === 200 && status.json["state"] === "idle" && status.json["fence"] === 0, "a signed status through the channel answers the record of a new installation");
  check.expect(JSON.stringify(status.json["app"]) === '{"running":true,"health":"healthy"}', "the status shows the app of the project of the updater, running and healthy", run(["logs", "--tail", "5", updaterId]).output);
  const replayed = envelopeOf({ type: "status" });
  send(x, replayed);
  check.expect(send(x, replayed).json["code"] === "REPLAYED", "the same command sent again is refused as a replay");
  check.expect(send(x, envelopeOf({ type: "status" }), { signature: `v1=${"0".repeat(64)}` }).json["code"] === "BAD_SIGNATURE", "a wrong signature is refused");
  const first = send(x, envelopeOf({ type: "install", release: "1.2.3", fence: 5 }));
  check.expect(first.status === 501 && first.json["code"] === "INSTALL_NOT_AVAILABLE", "an install is begun and closed as not available until the steps of the update arrive");
  const journalFile = path.join(x.dir, "control", "update-state.json");
  const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { record: { state: string; fence: number; error: { code: string } | null } };
  check.expect(journal.record.state === "idle" && journal.record.fence === 5 && journal.record.error?.code === "INSTALL_NOT_AVAILABLE", "the journal in the control folder of the installation holds the fence and the code");
  check.expect(statSync(journalFile).uid === (process.getuid?.() ?? -1), "the journal is a file of the host user");
  check.expect(send(x, envelopeOf({ type: "install", release: "1.2.3", fence: 4 })).json["code"] === "STALE_FENCE", "a smaller fence is refused as a crashed writer");

  // The restart: the journal stays, the old commands are stale.
  const beforeRestart = envelopeOf({ type: "status" }, Date.now());
  check.expect(compose(x, "restart", "updater").status === 0 && (await healthy(updaterId)), "the updater restarts and is healthy");
  const afterRestart = send(x, envelopeOf({ type: "status" }));
  check.expect(afterRestart.status === 200 && afterRestart.json["fence"] === 5, "after the restart the status holds the fence of before");
  check.expect(send(x, beforeRestart).json["code"] === "STALE", "a command made before the restart is stale, though nothing in its signature says so");
  check.expect(send(x, envelopeOf({ type: "install", release: "1.2.3", fence: 4 })).json["code"] === "STALE_FENCE", "the crashed writer is still refused after the restart");
  check.expect(send(x, envelopeOf({ type: "install", release: "1.2.3", fence: 6 })).status === 501, "the current fence is taken after the restart");

  // Its own app only.
  check.expect(compose(x, "stop", "app").status === 0, "the app of X is stopped");
  const stopped = send(x, envelopeOf({ type: "status" }));
  check.expect((stopped.json["app"] as { running?: boolean } | null)?.running === false && inspectOf(idOf(y, "app"))["State"].Running === true, "the status shows the app of X stopped while the app of Y runs: the updater looks at its own project");

  // The log holds no secret.
  const log = run(["logs", updaterId]).output;
  check.expect(log.includes("updater.listening") && !log.includes(TOKEN) && !log.includes("v1=") && !log.includes(replayed.nonce), "the log holds events and codes and no token, signature or nonce");

  // No start without a token.
  for (const env of [[], ["-e", "UPDATER_TOKEN=zz"], ["-e", `UPDATER_TOKEN=${TOKEN}`]]) {
    const refused = run(["run", "--rm", ...env, UPDATER_TAG]);
    const expectedField = env.length === 0 || env[1] === "UPDATER_TOKEN=zz" ? "UPDATER_TOKEN" : "COMPOSE_PROJECT_NAME";
    check.expect(refused.status === 1 && refused.output.includes('"CONFIG_INVALID"') && refused.output.includes(expectedField) && !refused.output.includes(TOKEN) && !refused.output.includes("zz\""), `the image does not start without ${expectedField} of the right shape and prints no value of it`, refused.output);
  }
} finally {
  for (const instance of [x, y]) if (instance) run(["compose", "down", "-v", "--remove-orphans", "-t", "5"], instance.dir);
  run(["rm", "-f", registryName]);
  run(["image", "rm", "-f", APP_TAG, UPDATER_TAG]);
  rmSync(root, { recursive: true, force: true });
}
check.finish();
