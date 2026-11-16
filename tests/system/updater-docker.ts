// D52.4 — the Docker adapter of the updater on a real daemon, with two installations of Compose side by side
// (Architektura §11.2.1). A local registry gives the images the digests the release file pins. The updater of
// installation X (the adapter, here run from this process on the socket; the container of the updater is D52.5)
// finds only its own app, refuses a container of installation Y, a stranger without labels and an image or a package
// name that is not valid, replaces the app by the image of release B and brings it back to A, then, once B is
// committed, `docker compose up -d` from the folder of X keeps B; the database is recovered from a package by a helper
// of a pinned image with only the folders of that app. Y is the same container, the same image and the same start at
// the end. Nothing of the installation keys or of the owner's password is printed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort, prepareComposeInstance, type ComposeInstance } from "../support/compose-instance.ts";
import { docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { createEngineClient } from "../../apps/updater/dist/docker/engine-client.js";
import { createProjectScope, ScopeError } from "../../apps/updater/dist/docker/project-scope.js";
import { writeReleaseFile } from "../../apps/updater/dist/release/release-file.js";
import { openJournal } from "../../apps/updater/dist/journal/journal.js";
import { beginInstall } from "../../apps/updater/dist/state-machine/begin.js";
import { initialRecord, transition } from "../../apps/updater/dist/state-machine/transitions.js";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";

const { platform } = requireNativeDocker(repoRoot);
const check = createCheck(`the Docker adapter of the updater on ${platform}`);
const IMAGE_A = "openlife-app:updater-a";
const IMAGE_B = "openlife-app:updater-b";
const OWNER = { email: "owner@example.test", password: "a passphrase for the second factor" };

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

const socketPath = ((): string => {
  const host = run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.trim();
  return host.startsWith("unix://") ? host.slice("unix://".length) : "/var/run/docker.sock";
})();
const engine = createEngineClient(socketPath);
const imageDigests = (image: string): string[] => (JSON.parse(run(["image", "inspect", image]).stdout)[0] as { RepoDigests?: string[] }).RepoDigests ?? [];
const inspectOf = (id: string): Record<string, any> => JSON.parse(run(["inspect", id]).stdout)[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function healthy(id: string, seconds = 90): Promise<boolean> {
  for (let waited = 0; waited < seconds; waited += 1) {
    const state = inspectOf(id)["State"] as { Running: boolean; Health?: { Status: string } };
    if (state.Running && state.Health?.Status === "healthy") return true;
    await sleep(1000);
  }
  return false;
}
const refused = async (call: () => Promise<unknown>, code: string): Promise<boolean> => {
  try {
    await call();
    return false;
  } catch (error) {
    return error instanceof ScopeError && error.code === code;
  }
};

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-updater-"));
const registryName = `openlife-registry-${process.pid}`;
const compose = (instance: ComposeInstance, ...args: string[]) => run(["compose", ...args], instance.dir);
let x: ComposeInstance | undefined;
let y: ComposeInstance | undefined;
let stranger: string | undefined;
try {
  for (const [tag, revision] of [[IMAGE_A, "updater-a"], [IMAGE_B, "updater-b"]] as const) {
    const built = docker(["build", "--platform", platform, "-f", "docker/Dockerfile", "--build-arg", `BUILD_REVISION=${revision}`, "-t", tag, "."], repoRoot, 15 * 60 * 1000);
    check.expect(built.status === 0, `docker build of release ${revision} exits 0`, built.output);
  }
  const registryPort = await freeLoopbackPort();
  const started = run(["run", "-d", "--name", registryName, "-p", `127.0.0.1:${registryPort}:5000`, "registry:2"]);
  check.expect(started.status === 0, "a local registry is running for the digests", started.output);
  await sleep(2000);
  const repository = `localhost:${registryPort}/openlife-app`;
  const digests: Record<string, string> = {};
  for (const [tag, name] of [[IMAGE_A, "a"], [IMAGE_B, "b"]] as const) {
    run(["tag", tag, `${repository}:${name}`]);
    const pushed = run(["push", `${repository}:${name}`]);
    check.expect(pushed.status === 0, `release ${name} is pushed to the registry`, pushed.output);
    digests[name] = run(["inspect", "--format", "{{index .RepoDigests 0}}", `${repository}:${name}`]).stdout.trim().split("@")[1] ?? "";
  }
  const refA = `${repository}@${digests["a"]}`;
  const refB = `${repository}@${digests["b"]}`;
  check.expect(/^sha256:[0-9a-f]{64}$/.test(digests["a"] ?? "") && digests["a"] !== digests["b"], "the two releases have digests and they differ");

  const pin = (digest: string | undefined) => ({ repository, digest: digest ?? "" });
  const instances: ComposeInstance[] = [];
  for (const name of ["x", "y"]) {
    const instance = prepareComposeInstance(path.join(root, name), { image: IMAGE_A, port: await freeLoopbackPort() });
    const written = writeReleaseFile(path.join(instance.dir, "control"), { app: pin(digests["a"]), updater: null });
    check.expect(written.ok, `the choice of release A is written for installation ${name}`);
    check.expect(compose(instance, "up", "-d", "--wait", "--wait-timeout", "120").status === 0, `installation ${name} is up on release A`);
    instances.push(instance);
  }
  [x, y] = instances as [ComposeInstance, ComposeInstance];
  const appId = (instance: ComposeInstance): string => compose(instance, "ps", "-q", "app").stdout.trim();
  const xApp = appId(x);
  const yApp = appId(y);
  const yBefore = { id: yApp, image: inspectOf(yApp)["Image"], startedAt: inspectOf(yApp)["State"].StartedAt };

  // The scope: its own app and nothing else.
  const scopeX = createProjectScope({ client: engine, project: x.projectName });
  const foundX = await scopeX.findApp();
  check.expect(foundX.id === xApp && foundX.id !== yApp, "the updater of X finds the app of X, not the app of Y on the same daemon");
  check.expect((await createProjectScope({ client: engine, project: y.projectName }).findApp()).id === yApp, "the updater of Y finds the app of Y");
  check.expect(await refused(() => scopeX.stopApp({ id: yApp, name: "y" }), "OUT_OF_SCOPE"), "the app of installation Y is out of the scope of X: stopping it is refused");
  check.expect(await refused(() => scopeX.inspectApp(yApp), "OUT_OF_SCOPE"), "inspecting the container of Y is refused too");
  stranger = run(["inspect", "--format", "{{.Id}}", registryName]).stdout.trim();
  check.expect(await refused(() => scopeX.stopApp({ id: stranger!, name: "stranger" }), "OUT_OF_SCOPE"), "a container with no labels of the project is out of scope");
  check.expect(await refused(() => scopeX.stopApp({ id: "does-not-exist", name: "none" }), "OUT_OF_SCOPE"), "an id that is no container is out of scope");
  check.expect(await refused(() => createProjectScope({ client: engine, project: x!.projectName, workingDir: "/somewhere/else" }).findApp(), "OUT_OF_SCOPE"), "the same project name in another folder is out of scope");
  check.expect(await refused(() => scopeX.pull("openlife-app:latest"), "IMAGE_INVALID") && (await refused(() => scopeX.replaceApp(foundX, `${repository}@sha256:short`), "IMAGE_INVALID")), "an image that is a tag or a short digest is refused before anything is sent");
  check.expect(await refused(() => scopeX.runRecovery(foundX, refA, "../../etc/passwd"), "PACKAGE_INVALID") && (await refused(() => scopeX.runRecovery(foundX, refA, "20261116T000000Z-manual-00000000-0000-4000-8000-000000000000'; id; '"), "PACKAGE_INVALID")), "a name of a package that is a path or holds a shell word is refused");
  check.expect(await refused(() => scopeX.runRecovery(foundX, refA, "20261116T000000Z-manual-00000000-0000-4000-8000-000000000000"), "SWITCH_FAILED"), "a recovery while the app runs is refused: the lease is the app's");

  // The data of X: an owner, a package of it, then a change the package does not have (a new password, with its audit entry).
  check.expect(compose(x, "stop", "app").status === 0, "the app of X is stopped for the package");
  const oneOff = (command: string[], input?: string) => run(["compose", "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "app", ...command], x!.dir, input);
  const owner = oneOff(["apps/server/dist/cli/create-owner.js"], JSON.stringify(OWNER));
  check.expect(owner.status === 0, "an owner is created, as a bundle of an installation without one is not made", owner.output);
  const backup = oneOff(["apps/server/dist/cli/backup-create.js"]);
  check.expect(backup.status === 0, "a bundle is made of the installation X at release A", backup.output);
  const packageName = /"directory":"([^"]+)"/.exec(backup.stdout)?.[1] ?? "";
  const reset = oneOff(["apps/server/dist/cli/reset-password.js"], JSON.stringify({ password: "a new long passphrase for the owner" }));
  check.expect(reset.status === 0, "the password is changed after the package, so the data differs from it", reset.output);
  const resetsIn = (instance: ComposeInstance): number => {
    const reader = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
    try {
      return (reader.handle.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'owner.password_reset'").get() as { n: number }).n;
    } finally {
      reader.close();
    }
  };
  check.expect(resetsIn(x) === 1, "the database of X holds the change");
  check.expect(compose(x, "start", "app").status === 0 && (await healthy(xApp)), "X runs on release A again");

  // The switch to B and the way back.
  // D54.1: a pull that proves what it pulled. A digest the registry does not hold is no image, and the one it holds is listed under its own name.
  check.expect(await refused(() => scopeX.pullVerified(`${repository}@sha256:${"0".repeat(64)}`), "PULL_FAILED"), "a digest the registry does not hold is refused as a failed pull, and the image is not there");
  check.expect(await refused(() => scopeX.pullVerified("openlife-app:latest"), "IMAGE_INVALID"), "a verified pull of a tag is refused before anything is sent");
  await scopeX.pullVerified(refB);
  check.expect(imageDigests(refB).includes(refB), "the image pulled by the digest of release B lists exactly that name among its digests");
  const toB = await scopeX.replaceApp(foundX, refB);
  check.expect(await healthy(toB.nextId).then((ok) => ok, () => false), "the app of release B is healthy");
  const bInfo = inspectOf(toB.nextId);
  check.expect(bInfo["Config"].Image === refB && bInfo["Name"] === `/${foundX.name}` && bInfo["HostConfig"].ReadonlyRootfs === true, "the new app is the image pinned by the digest, has the name of the old and keeps its hardening");
  check.expect(inspectOf(toB.previousId)["State"].Running === false && inspectOf(toB.previousId)["Name"] === `/${toB.previousName}`, "the old app is kept, stopped and renamed aside");
  await scopeX.rollbackApp(toB);
  const backToA = inspectOf(toB.previousId);
  check.expect(backToA["State"].Running === true && backToA["Name"] === `/${foundX.name}` && backToA["Config"].Image === refA, "the way back puts the old app in its name and running, on release A");
  check.expect((await healthy(toB.previousId)) && run(["inspect", "--format", "{{.Id}}", toB.nextId]).status !== 0, "release A is healthy again and the app of B is gone");

  const again = await scopeX.replaceApp({ id: toB.previousId, name: foundX.name }, refB);
  check.expect(await healthy(again.nextId), "the next switch to release B is healthy");
  await scopeX.discardPrevious(again);
  check.expect(run(["inspect", again.previousId]).status !== 0, "committed: the old app is discarded");

  // After the commit the choice is in the file, and a plain Compose from the folder keeps it.
  const chosen = writeReleaseFile(path.join(x.dir, "control"), { app: pin(digests["b"]), updater: null });
  check.expect(chosen.ok, "the choice of release B is written to the release file");
  check.expect(compose(x, "up", "-d", "--wait", "--wait-timeout", "120").status === 0, "a plain `docker compose up -d` from the folder of X succeeds");
  const afterCompose = inspectOf(appId(x));
  check.expect(afterCompose["Config"].Image === refB && afterCompose["State"].Running === true, "after it the app is still release B: Compose does not take the version back");
  check.expect(compose(x, "restart", "app").status === 0 && (await healthy(appId(x))) && inspectOf(appId(x))["Config"].Image === refB, "after a restart of the container, release B");

  // The database from the package, by a helper of a pinned image with the folders of the app only.
  const appNow = await scopeX.findApp();
  await scopeX.stopApp(appNow);
  const helper = await scopeX.runRecovery(appNow, refA, packageName);
  check.expect(helper.exitCode === 0 && helper.event?.["event"] === "instance.restored", "the helper restores the database of X from the package", JSON.stringify(helper.event));
  check.expect(resetsIn(x) === 0, "the database of X is the package's: the change made after it is gone");
  check.expect(inspectOf(appNow.id)["State"].Running === false && run(["ps", "-a", "--filter", "label=com.openlife.updater.helper=1", "-q"]).stdout.trim() === "", "the app stays stopped for the owner of the update to start, and the helper is gone");
  await scopeX.startApp(appNow);
  check.expect(await healthy(appNow.id), "the app starts on the recovered database");

  // The fence: the crashed writer after a restart of the updater.
  const journalDir = mkdtempSync(path.join(root, "journal-"));
  const envelope = (fence: number) => ({ v: 1 as const, operationId: "11111111-1111-4111-8111-111111111111", issuedAt: Date.now(), nonce: "n".repeat(24), command: { type: "install" as const, release: "1.2.3", fence } });
  const begun = beginInstall(initialRecord(new Date().toISOString()), envelope(3), new Date().toISOString());
  if (begun.ok) {
    const closed = transition(begun.record, "idle", {}, new Date().toISOString());
    openJournal(journalDir).write(begun.record);
    if (closed.ok) openJournal(journalDir).write(closed.record);
  }
  const reopened = openJournal(journalDir).read();
  const record = reopened.ok ? reopened.record : null;
  check.expect(record !== null && beginInstall(record, envelope(2), new Date().toISOString()).ok === false && beginInstall(record, envelope(3), new Date().toISOString()).ok === true, "after a restart of the updater the fence of the crashed writer is refused and the current one is taken");

  // Y was never touched.
  const yAfter = { id: appId(y), image: inspectOf(appId(y))["Image"], startedAt: inspectOf(appId(y))["State"].StartedAt };
  check.expect(JSON.stringify(yAfter) === JSON.stringify(yBefore) && inspectOf(appId(y))["State"].Running === true, "the app of installation Y is the same container, the same image and the same start as before everything");
} finally {
  for (const instance of [x, y]) if (instance) run(["compose", "down", "-v", "--remove-orphans", "-t", "5"], instance.dir);
  run(["rm", "-f", registryName]);
  run(["image", "rm", "-f", IMAGE_A, IMAGE_B]);
  rmSync(root, { recursive: true, force: true });
}
check.finish();
