// D56.4 — an update that goes wrong, on a real daemon, from the route of the application to the old app on its copy (Architektura §11.2.2
// "Awaria przed commit point", §11.3.3; DEV §9.55). The images are real: the app of this checkout (A), a release whose migration fails (F07 B-broken),
// a release that starts and migrates but never proves itself (B-silent), and the updater; a local registry gives their digests and the updater is a
// service of Compose. For each broken release an installation of its own with an owner, an option of his own, and the update started from the route
// with a fresh second factor. What is looked at after it is the same for both: the updater says the operation ended `idle` with the code of the
// failure, the app that runs is A on its image, healthy, on the database of the copy (the option and the owner are there, the migration of the
// release is not, the restore is in the audit and the start is too), the new app is gone, the release file is as it was, the gate holds no
// operation, the copy is still there, and a write (a sign-in) is taken. The second release is also tried with its updater killed while it waits
// for the proof: the updater that comes back finds the operation in `verifying`, and goes back to the old app, with the code of the new app that
// could not ask it while it was down (B_EXITED) or of the time that ran out (START_TIMEOUT).
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
import { writeReleaseFile } from "../../apps/updater/dist/release/release-file.js";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { PRODUCT_MIGRATION_PLAN, sqlChecksum, targetSchemaVersion } from "../../packages/sqlite/dist/migrations/public.js";

const { platform } = requireNativeDocker(repoRoot);
const check = createCheck(`an update that goes wrong on ${platform}`);
const TAGS = { a: "openlife-app:rollback-a", broken: "openlife-app:rollback-broken", silent: "openlife-app:rollback-silent", updater: "openlife-updater:rollback" } as const;
const TOKEN = randomBytes(32).toString("hex");
const TARGET = "1.3.0";
const OWNER = { email: "owner@example.test", password: "a passphrase for the second factor" };
const NIGHTLY_KEEP = 21;
const START_TIMEOUT_SECONDS = 60;

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

type Status = { state?: string; committed?: boolean; operationId?: string | null; error?: { code: string } | null };
/** A signed `status` command, sent from inside the service of the updater, as a client of the network of the installation would. */
function updaterStatus(instance: ComposeInstance): Status {
  const envelope: UpdaterEnvelope = { v: 1, operationId: randomUUID(), issuedAt: Date.now(), nonce: randomBytes(24).toString("base64url"), command: { type: "status" } };
  const body = JSON.stringify(envelope);
  const signature = signCommand(TOKEN, { method: UPDATER_COMMAND_METHOD, path: UPDATER_COMMAND_PATH, envelope, body });
  const script = `let input='';process.stdin.on('data',(c)=>input+=c).on('end',async()=>{const {body,signature}=JSON.parse(input);const r=await fetch('http://127.0.0.1:9090${UPDATER_COMMAND_PATH}',{method:'POST',headers:{'content-type':'application/json','${UPDATER_SIGNATURE_HEADER}':signature},body});console.log(JSON.stringify(await r.json()));});`;
  const result = run(["compose", "exec", "-T", "updater", "node", "-e", script], instance.dir, JSON.stringify({ body, signature }));
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Status;
  } catch {
    return {};
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-update-rollback-"));
const registryName = `openlife-registry-rollback-${process.pid}`;
const instances: ComposeInstance[] = [];
const feeds: string[] = [];
let copy: string | undefined;
try {
  // The two broken releases: copies of this checkout of version 1.3.0, each with its own change.
  const releaseCopy = (change: (dir: string) => void): string => {
    const dir = copyRepository();
    const packageFile = path.join(dir, "apps/server/package.json");
    writeFileSync(packageFile, readFileSync(packageFile, "utf8").replace(/"version": "[^"]+"/, `"version": "${TARGET}"`));
    change(dir);
    return dir;
  };
  const migration = (dir: string, sql: string): void => {
    writeFileSync(path.join(dir, "packages/sqlite/src/migrations/0099-update-fixture.ts"), `import type { Migration } from "./migration.js";\n\nexport const UPDATE_FIXTURE_MIGRATION: Migration = {\n  version: ${PRODUCT_MIGRATION_PLAN.length + 1},\n  id: "0099-update-fixture",\n  sql: ${JSON.stringify(sql)},\n  checksum: "${sqlChecksum(sql)}",\n};\n`);
    const planFile = path.join(dir, "packages/sqlite/src/migrations/plan.ts");
    writeFileSync(planFile, readFileSync(planFile, "utf8").replace("export const PRODUCT_MIGRATION_PLAN", 'import { UPDATE_FIXTURE_MIGRATION } from "./0099-update-fixture.js";\nexport const PRODUCT_MIGRATION_PLAN').replace(/TRUSTED_DEVICE_LABEL_MIGRATION\];/, "TRUSTED_DEVICE_LABEL_MIGRATION, UPDATE_FIXTURE_MIGRATION];"));
  };
  const BROKEN_SQL = "CREATE TABLE update_fixture (id INTEGER PRIMARY KEY) STRICT;\nCREATE TABLE update_fixture (id INTEGER PRIMARY KEY) STRICT;\n";
  const GOOD_SQL = "CREATE TABLE update_fixture (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;\nINSERT INTO update_fixture (id, note) VALUES (1, 'migrated by the release 1.3.0');\n";
  const brokenDir = releaseCopy((dir) => migration(dir, BROKEN_SQL));
  const silentDir = releaseCopy((dir) => {
    migration(dir, GOOD_SQL);
    // The new app migrates and runs but never proves itself: its own reading of the database is made to fail.
    const mainFile = path.join(dir, "apps/server/src/main.ts");
    const source = readFileSync(mainFile, "utf8");
    if (!source.includes('integrity?.quick_check === "ok"')) throw new Error("the proof of the new app is not where this test expects it");
    writeFileSync(mainFile, source.replace('integrity?.quick_check === "ok"', 'integrity?.quick_check === "never-ok"'));
  });
  copy = brokenDir;
  for (const [tag, context, target] of [[TAGS.a, repoRoot, undefined], [TAGS.broken, brokenDir, undefined], [TAGS.silent, silentDir, undefined], [TAGS.updater, repoRoot, "updater"]] as const) {
    const built = docker(["build", "--platform", platform, "-f", "docker/Dockerfile", ...(target === undefined ? [] : ["--target", target]), "-t", tag, "."], context, 20 * 60 * 1000);
    check.expect(built.status === 0, `docker build of ${tag} exits 0`, built.output);
  }
  removeCopy(silentDir);

  const registryPort = await freeLoopbackPort();
  check.expect(run(["run", "-d", "--name", registryName, "-p", `127.0.0.1:${registryPort}:5000`, "registry:2"]).status === 0, "a local registry is running for the digests");
  await sleep(2000);
  const pins: Record<string, { repository: string; digest: string }> = {};
  for (const [tag, name] of [[TAGS.a, "app-a"], [TAGS.broken, "app-broken"], [TAGS.silent, "app-silent"], [TAGS.updater, "updater"]] as const) {
    const repository = `localhost:${registryPort}/openlife-${name}`;
    run(["tag", tag, `${repository}:t`]);
    check.expect(run(["push", `${repository}:t`]).status === 0, `${name} is pushed to the registry`);
    pins[name] = { repository, digest: run(["inspect", "--format", "{{index .RepoDigests 0}}", `${repository}:t`]).stdout.trim().split("@")[1] ?? "" };
  }
  const dockerGid = process.platform === "linux" ? String(statSync("/var/run/docker.sock").gid) : "0";

  /** One installation on the app A with an owner and an option, the broken release in its catalog, and the update started from the route. */
  async function scenario(name: string, release: "app-broken" | "app-silent", expectedCodes: readonly string[], killUpdaterWhileVerifying: boolean): Promise<void> {
    const port = await freeLoopbackPort();
    const feedPort = await freeLoopbackPort();
    const x = prepareComposeInstance(path.join(root, name), {
      image: TAGS.a,
      port,
      updater: { token: TOKEN, releasesRepo: "example/openlife-releases", dockerGid },
      extraEnv: { RELEASES_API_URL: `http://127.0.0.1:${feedPort}`, UPDATER_START_TIMEOUT_SECONDS: String(START_TIMEOUT_SECONDS) },
    });
    instances.push(x);
    const control = path.join(x.dir, "control");
    check.expect(writeReleaseFile(control, { app: pins["app-a"]!, updater: pins["updater"]! }).ok, `${name}: the release file pins the app A and the updater`);
    const fileBefore = readFileSync(path.join(control, "compose.release.yml"), "utf8");
    writeFileSync(path.join(control, "release-catalog.json"), catalogFileTextOf({ v: 1, releases: [{ version: TARGET, app: pins[release]!, updater: null, minFrom: null, schemaVersion: targetSchemaVersion(PRODUCT_MIGRATION_PLAN) + 1 }] }));
    const compose = (...args: string[]) => run(["compose", ...args], x.dir);
    check.expect(compose("up", "-d", "--wait", "--wait-timeout", "120").status === 0, `${name}: the installation is up on the app A`);
    check.expect(compose("stop", "app").status === 0, `${name}: the app is stopped for the command of the owner`);
    const owner = run(["compose", "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "app", "apps/server/dist/cli/create-owner.js"], x.dir, JSON.stringify(OWNER));
    check.expect(owner.status === 0, `${name}: an owner is created`, owner.output);
    check.expect(compose("start", "app").status === 0, `${name}: the app A starts again`);
    const appA = compose("ps", "-q", "app").stdout.trim();
    check.expect(await healthy(appA), `${name}: the app A is healthy`);
    const feed = `require('node:http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify([{tag_name:'v${TARGET}',draft:false,prerelease:false,published_at:'2026-11-10T12:00:00Z',body:'the release for the test',html_url:'https://example.test/elsewhere'}]));}).listen(${feedPort},'127.0.0.1');`;
    const feedName = `openlife-feed-rollback-${process.pid}-${name}`;
    feeds.push(feedName);
    check.expect(run(["run", "-d", "--name", feedName, "--network", `container:${appA}`, "--entrypoint", "node", TAGS.a, "-e", feed]).status === 0, `${name}: the source of the releases is up on the loopback of the app`);
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
    check.expect((await call("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: confirmed.json?.["batchId"] }, cookie)).status === 200 && (await call("POST", "/api/v1/setup/choose-empty", {}, cookie)).status === 200, `${name}: the owner has passed the factor and chosen the empty start`);
    check.expect((await call("PATCH", "/api/v1/settings", { values: { "backup.nightlyKeep": NIGHTLY_KEEP } }, cookie)).status === 200, `${name}: the owner has an option of his own`);
    check.expect((await call("POST", "/api/v1/updates/check", {}, cookie)).json?.["available"] === true, `${name}: the check found the release`);
    const started = await call("POST", "/api/v1/updates/install", { release: TARGET }, cookie);
    check.expect(started.status === 202, `${name}: the update is started with the fresh factor`, JSON.stringify(started.json));

    // The operation as the updater has it, until it ends. For the silent release the updater is killed while it waits for the proof, and comes back.
    let killed = false;
    let last: Status = {};
    // What the new app was doing, kept while it exists, so that a failure of the operation can be read afterwards.
    let seenOfTheNewApp = "";
    for (let waited = 0; waited < 420; waited += 1) {
      last = updaterStatus(x);
      if (last.state === "verifying") {
        const others = run(["ps", "-a", "--filter", `label=com.docker.compose.project=${x.projectName}`, "--filter", "label=com.docker.compose.service=app", "--format", "{{.ID}} {{.Status}} {{.Names}}"]).stdout.trim().split("\n").filter((line) => line !== "" && !line.startsWith(appA.slice(0, 12)));
        const newest = others[0]?.split(" ")[0];
        if (newest !== undefined) seenOfTheNewApp = `${others.join(" | ")}\n${run(["logs", "--tail", "25", newest]).output}`.slice(-3000);
      }
      if (killUpdaterWhileVerifying && !killed && last.state === "verifying") {
        check.expect(run(["kill", compose("ps", "-q", "updater").stdout.trim()]).status === 0, `${name}: the updater is killed while it waits for the proof`);
        killed = true;
        await sleep(2000);
        check.expect(compose("start", "updater").status === 0, `${name}: the updater is started again`);
        await sleep(3000);
        continue;
      }
      if (last.state === "recovery_failed" || (last.state === "idle" && last.error) || last.state === "completed") break;
      await sleep(1000);
    }
    check.expect(!killUpdaterWhileVerifying || killed, `${name}: the updater was killed in the state verifying`);
    check.expect(last.state === "idle" && expectedCodes.includes(last.error?.code ?? "") && last.committed === false, `${name}: the updater ended the operation idle with ${expectedCodes.join(" or ")}`, `${JSON.stringify(last)}\n${seenOfTheNewApp}`);

    // The old app is back, on its image, healthy, on the database of the copy.
    const appNow = compose("ps", "-q", "app").stdout.trim();
    check.expect(appNow !== "" && inspectOf(appNow)["Config"].Image === `${pins["app-a"]!.repository}@${pins["app-a"]!.digest}` && (await healthy(appNow)), `${name}: the app that runs is A on its image and is healthy`);
    const apps = run(["ps", "-a", "--filter", `label=com.docker.compose.project=${x.projectName}`, "--filter", "label=com.docker.compose.service=app", "-q"]).stdout.trim().split("\n").filter(Boolean);
    check.expect(apps.length === 1 && apps[0] === appNow.slice(0, apps[0]!.length), `${name}: the new app is gone and no other app of the project is left`, apps.join(","));
    check.expect(readFileSync(path.join(control, "compose.release.yml"), "utf8") === fileBefore, `${name}: the release file is as it was`);
    check.expect(JSON.parse(readFileSync(path.join(control, "maintenance", "state.json"), "utf8")).activeOperation === null, `${name}: the gate holds no operation`);
    const packages = readdirSync(path.join(x.dir, "data", "backup")).filter((entry) => !entry.startsWith("."));
    check.expect(packages.filter((entry) => entry.includes("-pre_update-")).length === 1, `${name}: the copy before the update is still there`, packages.join(","));
    const reader = openDatabase(path.join(x.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
    try {
      const count = (sql: string): number => (reader.handle.prepare(sql).get() as { n: number }).n;
      check.expect(count("SELECT count(*) AS n FROM schema_migration") === PRODUCT_MIGRATION_PLAN.length && count("SELECT count(*) AS n FROM sqlite_master WHERE name = 'update_fixture'") === 0, `${name}: the database is the copy's, at the schema of A, without the migration of the release`);
      check.expect(count("SELECT count(*) AS n FROM app_setting WHERE key = 'backup.nightlyKeep'") === 1 && count('SELECT count(*) AS n FROM "user"') === 1, `${name}: the option and the owner are there`);
      check.expect(count("SELECT count(*) AS n FROM audit_log WHERE action = 'update.started'") === 1 && count("SELECT count(*) AS n FROM audit_log WHERE action = 'backup.restored'") === 1, `${name}: the start of the update and the restore are in the audit log, once`);
    } finally {
      reader.close();
    }
    check.expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200, `${name}: the health probe says ok`);
    check.expect((await call("POST", "/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password }, null)).status === 200, `${name}: a sign-in, which writes, is taken (the old session is ended by the restore)`);
    check.expect((await call("GET", "/api/v1/updates", undefined, cookie)).status === 401, `${name}: the session of before the restore is ended`);
  }

  await scenario("broken", "app-broken", ["B_MIGRATION_FAILED"], false);
  await scenario("silent", "app-silent", ["START_TIMEOUT"], false);
  // With the updater down the new app cannot ask it about the operation at its start and ends; Docker starts it again, and the updater that comes
  // back, which counts that as the end of the new app (B_EXITED) or runs out of time (START_TIMEOUT), goes back either way, never opens the writes.
  await scenario("killed", "app-silent", ["B_EXITED", "START_TIMEOUT"], true);
} finally {
  for (const instance of instances) run(["compose", "down", "-v", "--remove-orphans", "-t", "5"], instance.dir);
  run(["rm", "-f", registryName, ...feeds]);
  run(["image", "rm", "-f", TAGS.a, TAGS.broken, TAGS.silent, TAGS.updater]);
  if (copy !== undefined) removeCopy(copy);
  rmSync(root, { recursive: true, force: true });
}
check.finish();
