// D55.4 — an update A → B on a real daemon, from the route of the application to the choice of the release, with every
// part real (Architektura §11.2.2 steps 1 to 7; DEV §9.54): the image of the app of this checkout (A), the image of a release
// that has another version and one controlled migration (B, built from a copy of this checkout), the image of the updater,
// a local registry for their digests, the updater as a service of Compose and an owner with data and an option of his own.
// The owner starts the update with a fresh second factor; the updater pulls B, the app A closes its writes and takes the
// `pre_update` copy, the updater replaces A by B, B migrates the database under the operation, proves itself, the updater
// commits the choice of the release, and only then B opens its writes. After it the data and the option are there, the
// migration is made, there is one copy and none of the copy before the migration, the file of the release pins B and the
// updater of the installation, the replaced app is gone, a plain `docker compose up -d` keeps B, and the gate holds no operation.
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_SIGNATURE_HEADER, type UpdaterEnvelope } from "@openlife/contracts/updates/protocol";
import { createCheck } from "../support/check-report.ts";
import { codeOf, secretOf } from "../support/auth-http.ts";
import { freeLoopbackPort, prepareComposeInstance, type ComposeInstance } from "../support/compose-instance.ts";
import { docker, requireNativeDocker } from "../support/docker.ts";
import { copyRepository, removeCopy, repoRoot } from "../support/repository-copy.ts";
import { signCommand } from "../../apps/updater/dist/protocol/verify-command.js";
import { catalogFileTextOf } from "../../apps/updater/dist/release/catalog.js";
import { readReleaseFile, writeReleaseFile } from "../../apps/updater/dist/release/release-file.js";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { PRODUCT_MIGRATION_PLAN, sqlChecksum, targetSchemaVersion } from "../../packages/sqlite/dist/migrations/public.js";

const { platform } = requireNativeDocker(repoRoot);
const check = createCheck(`an update A to B on ${platform}`);
const TAGS = { a: "openlife-app:update-a", b: "openlife-app:update-b", updater: "openlife-updater:update-switch" } as const;
const TOKEN = randomBytes(32).toString("hex");
const TARGET = "1.3.0";
const OWNER = { email: "owner@example.test", password: "a passphrase for the second factor" };
const NIGHTLY_KEEP = 21;

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

async function healthy(id: string, seconds = 120): Promise<boolean> {
  for (let waited = 0; waited < seconds; waited += 1) {
    const state = inspectOf(id)["State"] as { Running: boolean; Health?: { Status: string } };
    if (state.Running && state.Health?.Status === "healthy") return true;
    await sleep(1000);
  }
  return false;
}

/** A signed command, sent from inside the service of the updater, as a client of the network of the installation would. */
function updaterStatus(instance: ComposeInstance): { state?: string; committed?: boolean; error?: { code: string } | null; targetRelease?: string | null } {
  const envelope: UpdaterEnvelope = { v: 1, operationId: randomUUID(), issuedAt: Date.now(), nonce: randomBytes(24).toString("base64url"), command: { type: "status" } };
  const body = JSON.stringify(envelope);
  const signature = signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body });
  const script = `let input='';process.stdin.on('data',(c)=>input+=c).on('end',async()=>{const {body,signature}=JSON.parse(input);const r=await fetch('http://127.0.0.1:9090${UPDATER_COMMAND_PATH}',{method:'POST',headers:{'content-type':'application/json','${UPDATER_SIGNATURE_HEADER}':signature},body});console.log(JSON.stringify(await r.json()));});`;
  const result = run(["compose", "exec", "-T", "updater", "node", "-e", script], instance.dir, JSON.stringify({ body, signature }));
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as ReturnType<typeof updaterStatus>;
  } catch {
    return {};
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-update-switch-"));
const registryName = `openlife-registry-update-${process.pid}`;
const feedName = `openlife-feed-update-${process.pid}`;
let x: ComposeInstance | undefined;
let copy: string | undefined;
try {
  // The release B: this checkout with another version and one more migration, which is all that makes it a release.
  copy = copyRepository();
  const packageFile = path.join(copy, "apps/server/package.json");
  writeFileSync(packageFile, readFileSync(packageFile, "utf8").replace(/"version": "[^"]+"/, `"version": "${TARGET}"`));
  const fixtureSql = "CREATE TABLE update_fixture (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;\nINSERT INTO update_fixture (id, note) VALUES (1, 'migrated by the release 1.3.0');\n";
  const version = PRODUCT_MIGRATION_PLAN.length + 1;
  writeFileSync(
    path.join(copy, "packages/sqlite/src/migrations/0099-update-fixture.ts"),
    `import type { Migration } from "./migration.js";\n\nexport const UPDATE_FIXTURE_MIGRATION: Migration = {\n  version: ${version},\n  id: "0099-update-fixture",\n  sql: ${JSON.stringify(fixtureSql)},\n  checksum: "${sqlChecksum(fixtureSql)}",\n};\n`,
  );
  const planFile = path.join(copy, "packages/sqlite/src/migrations/plan.ts");
  writeFileSync(planFile, readFileSync(planFile, "utf8").replace("export const PRODUCT_MIGRATION_PLAN", 'import { UPDATE_FIXTURE_MIGRATION } from "./0099-update-fixture.js";\nexport const PRODUCT_MIGRATION_PLAN').replace(/TRUSTED_DEVICE_LABEL_MIGRATION\];/, "TRUSTED_DEVICE_LABEL_MIGRATION, UPDATE_FIXTURE_MIGRATION];"));

  for (const [tag, context, target] of [[TAGS.a, repoRoot, undefined], [TAGS.b, copy, undefined], [TAGS.updater, repoRoot, "updater"]] as const) {
    const built = docker(["build", "--platform", platform, "-f", "docker/Dockerfile", ...(target === undefined ? [] : ["--target", target]), "-t", tag, "."], context, 20 * 60 * 1000);
    check.expect(built.status === 0, `docker build of ${tag} exits 0`, built.output);
  }
  const registryPort = await freeLoopbackPort();
  check.expect(run(["run", "-d", "--name", registryName, "-p", `127.0.0.1:${registryPort}:5000`, "registry:2"]).status === 0, "a local registry is running for the digests");
  await sleep(2000);
  const pins: Record<string, { repository: string; digest: string }> = {};
  for (const [tag, name] of [[TAGS.a, "app-a"], [TAGS.b, "app-b"], [TAGS.updater, "updater"]] as const) {
    const repository = `localhost:${registryPort}/openlife-${name}`;
    run(["tag", tag, `${repository}:t`]);
    check.expect(run(["push", `${repository}:t`]).status === 0, `${name} is pushed to the registry`);
    pins[name] = { repository, digest: run(["inspect", "--format", "{{index .RepoDigests 0}}", `${repository}:t`]).stdout.trim().split("@")[1] ?? "" };
  }

  const dockerGid = process.platform === "linux" ? String(statSync("/var/run/docker.sock").gid) : "0";
  const port = await freeLoopbackPort();
  const feedPort = await freeLoopbackPort();
  x = prepareComposeInstance(path.join(root, "x"), {
    image: TAGS.a,
    port,
    updater: { token: TOKEN, releasesRepo: "example/openlife-releases", dockerGid },
    // The source of the releases is a server of ours on the loopback of the container of the app (below), never GitHub.
    extraEnv: { RELEASES_API_URL: `http://127.0.0.1:${feedPort}` },
  });
  const control = path.join(x.dir, "control");
  check.expect(writeReleaseFile(control, { app: pins["app-a"]!, updater: pins["updater"]! }).ok, "the release file pins the app A and the updater by digest");
  writeFileSync(path.join(control, "release-catalog.json"), catalogFileTextOf({ v: 1, releases: [{ version: TARGET, app: pins["app-b"]!, updater: null, minFrom: null, schemaVersion: targetSchemaVersion(PRODUCT_MIGRATION_PLAN) + 1 }] }));
  const compose = (...args: string[]) => run(["compose", ...args], x!.dir);

  // The owner is made with the app stopped (its command takes the lease), once the first start has made the database; then everything of
  // the owner's goes through the app.
  check.expect(compose("up", "-d", "--wait", "--wait-timeout", "120").status === 0, "the installation with the updater is up on the app A");
  check.expect(compose("stop", "app").status === 0, "the app is stopped for the command of the owner");
  const owner = run(["compose", "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "app", "apps/server/dist/cli/create-owner.js"], x.dir, JSON.stringify(OWNER));
  check.expect(owner.status === 0, "an owner is created", owner.output);
  check.expect(compose("start", "app").status === 0, "the app A starts again");
  const appA = compose("ps", "-q", "app").stdout.trim();
  check.expect(await healthy(appA), "the app A is healthy");

  // The server of the releases, on the loopback of the container of the app: a container that shares its network.
  const feed = `require('node:http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify([{tag_name:'v${TARGET}',draft:false,prerelease:false,published_at:'2026-11-10T12:00:00Z',body:'the release for the test',html_url:'https://example.test/elsewhere'}]));}).listen(${feedPort},'127.0.0.1');`;
  check.expect(run(["run", "-d", "--name", feedName, "--network", `container:${appA}`, "--entrypoint", "node", TAGS.a, "-e", feed]).status === 0, "the source of the releases is up on the loopback of the app");
  await sleep(1500);

  const origin = `http://localhost:${port}`;
  const call = async (method: string, route: string, body: unknown, cookie: string | null) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { "Content-Type": "application/json", Origin: origin, ...(cookie === null ? {} : { Cookie: cookie }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: text === "" ? null : (JSON.parse(text) as Record<string, any>), cookie: response.headers.getSetCookie()[0]?.split(";")[0] ?? null }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const password = (await call("POST", "/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password }, null)).cookie;
  const begun = await call("POST", "/api/v1/mfa/enrollment/begin", {}, password);
  const confirmed = await call("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.json?.["challengeId"], code: await codeOf(secretOf(String(begun.json?.["otpauthUri"]))) }, password);
  const cookie = confirmed.cookie;
  check.expect((await call("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: confirmed.json?.["batchId"] }, cookie)).status === 200 && (await call("POST", "/api/v1/setup/choose-empty", {}, cookie)).status === 200, "the owner has passed the factor and chosen the empty start");
  const changed = await call("PATCH", "/api/v1/settings", { values: { "backup.nightlyKeep": NIGHTLY_KEEP } }, cookie);
  check.expect(changed.status === 200, "the owner has an option of his own, changed with a fresh factor", JSON.stringify(changed.json));

  const checked = await call("POST", "/api/v1/updates/check", {}, cookie);
  check.expect(checked.status === 200 && checked.json?.["available"] === true && checked.json?.["latest"]?.["version"] === TARGET, "the check found the release", JSON.stringify(checked.json));
  const started = await call("POST", "/api/v1/updates/install", { release: TARGET }, cookie);
  check.expect(started.status === 202, "the update is started with the fresh factor", JSON.stringify(started.json));
  const unfinished = await call("POST", "/api/v1/updates/install", { release: TARGET }, cookie);
  check.expect(unfinished.status === 409 || unfinished.status === 503, "a second start while it goes is refused", String(unfinished.status));

  // The operation as the updater has it, until the commit point; the gate shows the operation open until then.
  const gateFile = path.join(x.dir, "control", "maintenance", "state.json");
  const phases = new Set<string>();
  let last: ReturnType<typeof updaterStatus> = {};
  for (let waited = 0; waited < 360; waited += 1) {
    last = updaterStatus(x);
    try {
      const gate = JSON.parse(readFileSync(gateFile, "utf8")) as { activeOperation: { phase: string } | null };
      if (gate.activeOperation !== null) phases.add(gate.activeOperation.phase);
      if (last.committed !== true && last.state === "completed") break;
    } catch {
      // The file is replaced by a rename; a read in between is tried again.
    }
    if (last.state === "completed" || (last.state === "idle" && last.error) || last.state === "rolling_back" || last.state === "recovery_failed") break;
    await sleep(1000);
  }
  check.expect(last.state === "completed" && last.committed === true, "the updater has completed the operation after its commit point", JSON.stringify(last));
  check.expect(phases.has("switching") || phases.has("verifying"), "the gate held the operation while the app was switched and proved", [...phases].join(","));

  // After it: B runs under the name of A, healthy (its health says so only once the operation is committed), on the pinned image.
  const appB = compose("ps", "-q", "app").stdout.trim();
  const bInfo = inspectOf(appB);
  check.expect(appB !== "" && appB !== appA && bInfo["Config"].Image === `${pins["app-b"]!.repository}@${pins["app-b"]!.digest}`, "the app that runs is B, pinned by its digest, and not the container of A");
  check.expect(await healthy(appB), "B is healthy only after the operation is committed");
  check.expect(run(["ps", "-a", "--filter", "name=previous", "-q"]).stdout.trim() === "" && run(["inspect", appA]).status !== 0, "the replaced app is gone");
  const file = readReleaseFile(readFileSync(path.join(control, "compose.release.yml"), "utf8"));
  check.expect(file.ok && file.selection.app.digest === pins["app-b"]!.digest && file.selection.updater?.digest === pins["updater"]!.digest, "the release file pins B and keeps the updater of the installation");
  check.expect(JSON.parse(readFileSync(gateFile, "utf8")).activeOperation === null, "the gate holds no operation");
  const packages = readdirSync(path.join(x.dir, "data", "backup")).filter((name) => !name.startsWith("."));
  check.expect(packages.filter((name) => name.includes("-pre_update-")).length === 1 && !packages.some((name) => name.includes("-pre_migration-")), "there is the copy before the update and none before the migration", packages.join(","));

  // The data: the migration is made, the option and the owner are there, the start is audited.
  const reader = openDatabase(path.join(x.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  try {
    const count = (sql: string): number => (reader.handle.prepare(sql).get() as { n: number }).n;
    check.expect(count("SELECT count(*) AS n FROM schema_migration") === PRODUCT_MIGRATION_PLAN.length + 1 && count("SELECT count(*) AS n FROM update_fixture") === 1, "the database is migrated to the schema of B");
    check.expect(count("SELECT count(*) AS n FROM app_setting WHERE key = 'backup.nightlyKeep'") === 1 && count('SELECT count(*) AS n FROM "user"') === 1, "the option and the owner survived");
    check.expect(count("SELECT count(*) AS n FROM audit_log WHERE action = 'update.started'") === 1, "the start is in the audit log once");
  } finally {
    reader.close();
  }

  // The writes are open: the factor of the session is still fresh enough or the sign-in works, and the health is ok.
  const afterHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
  check.expect(afterHealth.status === 200, "the health probe says ok");
  const signedAgain = await call("POST", "/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password }, null);
  check.expect(signedAgain.status === 200, "a sign-in, which writes, is taken");
  const status = await call("GET", "/api/v1/updates", undefined, cookie);
  check.expect(status.status === 200 && status.json?.["current"] === TARGET, "the application says it runs the release", JSON.stringify(status.json));

  // A plain Compose from the folder keeps B.
  check.expect(compose("up", "-d", "--wait", "--wait-timeout", "120").status === 0, "a plain docker compose up -d succeeds");
  check.expect(inspectOf(compose("ps", "-q", "app").stdout.trim())["Config"].Image === `${pins["app-b"]!.repository}@${pins["app-b"]!.digest}`, "after it the app is still B");
} finally {
  if (x) run(["compose", "down", "-v", "--remove-orphans", "-t", "5"], x.dir);
  run(["rm", "-f", feedName, registryName]);
  run(["image", "rm", "-f", TAGS.a, TAGS.b, TAGS.updater]);
  if (copy !== undefined) removeCopy(copy);
  rmSync(root, { recursive: true, force: true });
}
check.finish();
