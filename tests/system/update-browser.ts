// D57.4 — an update from the browser on a real daemon, both ways (Scope §5.9, S14; Architektura §11.2.2; DEV §9.56). Every part is real: the app of this
// checkout (A), a release that has another version and one migration (B), a release whose migration fails (B-broken), the updater as a service of
// Compose, a local registry for the digests, and Chromium driven by Playwright as the owner, who signs in, asks for the check, starts the update with a
// fresh code of the second factor, watches it, and reads what became of it, all on the page of the updates.
// AC1 (A to B): the update from the page ends with the result "updated" for the version of B on the same page, the stream of events connected again to
//      the new app, the version mark says B, the data and the option are there, the start is in the audit, and a plain `docker compose up -d` keeps B.
// AC2 (A to a broken B and back): the page does not say the update succeeded; once the owner signs in again (the restore ended his session) it says in words
//      that the previous version runs on the copy and why, the database is the copy's (the option and the owner, no migration of the release), the app that
//      runs is A, the gate holds no operation and a plain `docker compose up -d` keeps A.
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium, type Locator, type Page } from "@playwright/test";
import { STREAM_PATH } from "@openlife/contracts/http/stream";
import { createCheck } from "../support/check-report.ts";
import { codeOf, secretOf } from "../support/auth-http.ts";
import { freeLoopbackPort, prepareComposeInstance, type ComposeInstance } from "../support/compose-instance.ts";
import { docker, requireNativeDocker } from "../support/docker.ts";
import { removeCopy, repoRoot } from "../support/repository-copy.ts";
import { apiCaller, healthy, inspectOf, releaseCopy, run, sleep, startFeed, updaterStatus, type UpdaterStatus } from "../support/update-rig.ts";
import { catalogFileTextOf } from "../../apps/updater/dist/release/catalog.js";
import { readReleaseFile, writeReleaseFile } from "../../apps/updater/dist/release/release-file.js";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { PRODUCT_MIGRATION_PLAN, targetSchemaVersion } from "../../packages/sqlite/dist/migrations/public.js";

const { platform } = requireNativeDocker(repoRoot);
const check = createCheck(`an update from the browser on ${platform}`);
const TAGS = { a: "openlife-app:browser-a", b: "openlife-app:browser-b", broken: "openlife-app:browser-broken", updater: "openlife-updater:browser" } as const;
const TOKEN = randomBytes(32).toString("hex");
const TARGET = "1.3.0";
const OWNER = { email: "owner@example.test", password: "a passphrase for the second factor" };
const NIGHTLY_KEEP = 21;
const WAIT_SECONDS = 420;

const text = (file: string): Record<string, any> => JSON.parse(readFileSync(path.join(repoRoot, "apps/web/src/locales/en", file), "utf8")); // eslint-disable-line @typescript-eslint/no-explicit-any
const settings = text("settings.json");
const auth = text("auth.json");
const common = text("common.json");
const say = (template: string, values: Record<string, string>) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, value), template);
const versionOfA = (JSON.parse(readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8")) as { version: string }).version;

const probe = docker(["compose", "version", "--short"], repoRoot);
if (probe.status !== 0) {
  check.expect(false, "the docker compose plugin is available", probe.output);
  check.finish();
  process.exit(process.exitCode ?? 1);
}

/** In by the password and a recovery code: a session with no fresh second factor, so the start of the update has to ask for a code. */
async function signIn(page: Page, origin: string, recoveryCode: string): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByLabel(auth["login"].email, { exact: true }).fill(OWNER.email);
  await page.getByLabel(auth["login"].password, { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: auth["login"].submit }).click();
  await page.getByRole("button", { name: auth["mfa"].useRecovery }).click();
  await page.getByLabel(auth["mfa"].recoveryLabel, { exact: true }).fill(recoveryCode);
  await page.getByRole("button", { name: auth["mfa"].submit }).click();
  await page.waitForURL(`${origin}/`);
}

type Seen = { stages: Set<string>; reconnecting: boolean; result: string | null; atLogin: boolean };
/** What the page says, read as it changes, while the updater does its work behind it. */
async function snapshot(page: Page): Promise<{ stage: string | null; reconnecting: boolean; result: string | null; atLogin: boolean }> {
  try {
    // A string, not a function: this file is type-checked without the DOM library, and the code runs in the page.
    return (await page.evaluate(`({
      stage: document.querySelector("section[data-operation]")?.getAttribute("data-operation") ?? null,
      reconnecting: document.querySelector("[data-reconnecting]") !== null,
      result: document.querySelector("section[data-result]")?.getAttribute("data-result") ?? null,
      atLogin: location.pathname.startsWith("/login"),
    })`)) as { stage: string | null; reconnecting: boolean; result: string | null; atLogin: boolean };
  } catch {
    // A navigation is going on (the session was ended and the page is taken to the sign-in).
    return { stage: null, reconnecting: false, result: null, atLogin: false };
  }
}

/** Whether the locator shows within the time: the page reads its state after it is drawn, so a look at once says nothing. */
const shows = (locator: Locator, timeout = 20_000): Promise<boolean> => locator.waitFor({ timeout }).then(() => true, () => false);

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-update-browser-"));
const registryName = `openlife-registry-browser-${process.pid}`;
const instances: ComposeInstance[] = [];
const feeds: string[] = [];
const copies: string[] = [];
try {
  const GOOD_SQL = "CREATE TABLE update_fixture (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;\nINSERT INTO update_fixture (id, note) VALUES (1, 'migrated by the release 1.3.0');\n";
  const BROKEN_SQL = "CREATE TABLE update_fixture (id INTEGER PRIMARY KEY) STRICT;\nCREATE TABLE update_fixture (id INTEGER PRIMARY KEY) STRICT;\n";
  const goodDir = releaseCopy(TARGET, GOOD_SQL);
  const brokenDir = releaseCopy(TARGET, BROKEN_SQL);
  copies.push(goodDir, brokenDir);
  for (const [tag, context, target] of [[TAGS.a, repoRoot, undefined], [TAGS.b, goodDir, undefined], [TAGS.broken, brokenDir, undefined], [TAGS.updater, repoRoot, "updater"]] as const) {
    const built = docker(["build", "--platform", platform, "-f", "docker/Dockerfile", ...(target === undefined ? [] : ["--target", target]), "-t", tag, "."], context, 20 * 60 * 1000);
    check.expect(built.status === 0, `docker build of ${tag} exits 0`, built.output);
  }
  const registryPort = await freeLoopbackPort();
  check.expect(run(["run", "-d", "--name", registryName, "-p", `127.0.0.1:${registryPort}:5000`, "registry:2"]).status === 0, "a local registry is running for the digests");
  await sleep(2000);
  const pins: Record<string, { repository: string; digest: string }> = {};
  for (const [tag, name] of [[TAGS.a, "app-a"], [TAGS.b, "app-b"], [TAGS.broken, "app-broken"], [TAGS.updater, "updater"]] as const) {
    const repository = `localhost:${registryPort}/openlife-${name}`;
    run(["tag", tag, `${repository}:t`]);
    check.expect(run(["push", `${repository}:t`]).status === 0, `${name} is pushed to the registry`);
    pins[name] = { repository, digest: run(["inspect", "--format", "{{index .RepoDigests 0}}", `${repository}:t`]).stdout.trim().split("@")[1] ?? "" };
  }
  const dockerGid = process.platform === "linux" ? String(statSync("/var/run/docker.sock").gid) : "0";
  const browser = await chromium.launch();

  async function scenario(name: string, release: "app-b" | "app-broken", outcome: "updated" | "returned"): Promise<void> {
    const port = await freeLoopbackPort();
    const feedPort = await freeLoopbackPort();
    const origin = `http://localhost:${port}`;
    const x = prepareComposeInstance(path.join(root, name), {
      image: TAGS.a,
      port,
      updater: { token: TOKEN, releasesRepo: "example/openlife-releases", dockerGid },
      extraEnv: { RELEASES_API_URL: `http://127.0.0.1:${feedPort}`, UPDATER_START_TIMEOUT_SECONDS: "60" },
    });
    instances.push(x);
    const control = path.join(x.dir, "control");
    check.expect(writeReleaseFile(control, { app: pins["app-a"]!, updater: pins["updater"]! }).ok, `${name}: the release file pins the app A and the updater by digest`);
    const fileBefore = readFileSync(path.join(control, "compose.release.yml"), "utf8");
    writeFileSync(path.join(control, "release-catalog.json"), catalogFileTextOf({ v: 1, releases: [{ version: TARGET, app: pins[release]!, updater: null, minFrom: null, schemaVersion: targetSchemaVersion(PRODUCT_MIGRATION_PLAN) + 1 }] }));
    const compose = (...args: string[]) => run(["compose", ...args], x.dir);
    check.expect(compose("up", "-d", "--wait", "--wait-timeout", "120").status === 0, `${name}: the installation with the updater is up on the app A`);
    check.expect(compose("stop", "app").status === 0, `${name}: the app is stopped for the command of the owner`);
    check.expect(run(["compose", "run", "--rm", "-T", "--no-deps", "--entrypoint", "node", "app", "apps/server/dist/cli/create-owner.js"], x.dir, JSON.stringify(OWNER)).status === 0, `${name}: an owner is created`);
    check.expect(compose("start", "app").status === 0, `${name}: the app A starts again`);
    const appA = compose("ps", "-q", "app").stdout.trim();
    check.expect(await healthy(appA), `${name}: the app A is healthy`);
    feeds.push(`openlife-feed-browser-${process.pid}-${name}`);
    check.expect(startFeed(feeds.at(-1)!, appA, TAGS.a, feedPort, TARGET), `${name}: the source of the releases is up on the loopback of the app`);
    await sleep(1500);

    // The owner is set up over HTTP (the setup is not what is tested here); everything after it is done in the browser.
    const call = apiCaller(port);
    const password = (await call("POST", "/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password }, null)).cookie;
    const begun = await call("POST", "/api/v1/mfa/enrollment/begin", {}, password);
    const secret = secretOf(String(begun.json?.["otpauthUri"]));
    const confirmed = await call("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.json?.["challengeId"], code: await codeOf(secret) }, password);
    const recoveryCodes = (confirmed.json?.["recoveryCodes"] ?? []) as string[];
    check.expect((await call("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: confirmed.json?.["batchId"] }, confirmed.cookie)).status === 200 && (await call("POST", "/api/v1/setup/choose-empty", {}, confirmed.cookie)).status === 200 && (await call("PUT", "/api/v1/setup/preferences", { timezone: "Europe/Warsaw", locale: "en" }, confirmed.cookie)).status === 200, `${name}: the owner has passed the factor, chosen the empty start and saved the preferences`);
    check.expect((await call("PATCH", "/api/v1/settings", { values: { "backup.nightlyKeep": NIGHTLY_KEEP } }, confirmed.cookie)).status === 200, `${name}: the owner has an option of his own`);

    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    let streams = 0;
    page.on("request", (request) => request.url().endsWith(STREAM_PATH) && (streams += 1));
    try {
      await signIn(page, origin, recoveryCodes[0] ?? "");
      await page.goto(`${origin}/settings/updates`);
      await page.getByRole("button", { name: settings["updates"].check.now }).click();
      const install = page.getByRole("button", { name: say(settings["updates"].install.button, { version: TARGET }) });
      await install.waitFor({ timeout: 30_000 });
      check.expect(await shows(page.getByText(say(settings["updates"].version.available, { version: TARGET }))), `${name}: the page offers the release found by the check`);
      const streamsBefore = streams;
      await install.click();
      await page.getByRole("group", { name: say(settings["updates"].install.confirmHeading, { version: TARGET }) }).getByRole("button", { name: settings["updates"].install.confirm }).click();
      // The session has no fresh second factor, so a code is asked for in the dialog of the page; the next code is the one not used yet.
      const dialog = page.getByRole("dialog", { name: settings["security"].stepUp.codeHeading });
      await dialog.waitFor({ timeout: 15_000 });
      await dialog.getByLabel(settings["security"].stepUp.codeLabel).fill(await codeOf(secret, 1));
      await dialog.getByRole("button", { name: settings["security"].stepUp.confirm }).click();
      await page.locator("section[data-operation]").first().waitFor({ timeout: 60_000 });
      check.expect(true, `${name}: the start with a fresh code of the second factor shows the progress on the page`);

      // The page and the updater side by side, until the updater has ended the operation.
      const seen: Seen = { stages: new Set(), reconnecting: false, result: null, atLogin: false };
      let last: UpdaterStatus = {};
      let ended = false;
      for (let waited = 0; waited < WAIT_SECONDS; waited += 1) {
        const view = await snapshot(page);
        if (view.stage !== null) seen.stages.add(view.stage);
        seen.reconnecting ||= view.reconnecting;
        seen.atLogin ||= view.atLogin;
        if (view.result !== null) seen.result = view.result;
        last = updaterStatus(x, TOKEN);
        ended = last.state === "completed" || (last.state === "idle" && last.error != null) || last.state === "recovery_failed";
        if (ended && (outcome === "returned" || seen.result !== null)) break;
        await sleep(1000);
      }
      check.expect(seen.stages.size > 0, `${name}: the page told the stages in words while the update went on`, [...seen.stages].join(","));
      console.log(`  info: ${name}: stages seen ${[...seen.stages].join(" > ")}; reconnecting shown: ${seen.reconnecting}; page signed out: ${seen.atLogin}; streams opened after the start: ${streams - streamsBefore}`);

      if (outcome === "updated") {
        check.expect(last.state === "completed" && last.committed === true, `${name}: the updater has completed the operation after its commit point`, JSON.stringify(last));
        await page.locator('section[data-result="updated"]').waitFor({ timeout: 60_000 });
        check.expect(await shows(page.getByText(say(settings["updates"].result.updated, { version: TARGET }))), `${name}: the same page says the application was updated to the release, with no reload and no sign-in`);
        check.expect(streams > streamsBefore, `${name}: the stream of events connected again to the new app`, `${streams - streamsBefore} streams after the start`);
        check.expect((await page.getByRole("navigation", { name: common["version"].navigation }).innerText()).includes(`v${TARGET}`), `${name}: the version mark says the version of B`);
        await page.reload();
        const runs = await shows(page.getByText(say(settings["updates"].version.current, { version: TARGET })));
        const stays = await shows(page.locator('section[data-result="updated"]'));
        check.expect(runs && stays, `${name}: after a reload the page runs the release and the result stays until it is closed`, `${runs} ${stays} ${page.url()}\n${(await page.locator("body").innerText()).slice(0, 800)}`);
        await page.locator('section[data-result="updated"]').getByRole("button", { name: settings["updates"].result.dismiss }).click();
        await page.reload();
        await shows(page.getByText(say(settings["updates"].version.current, { version: TARGET })));
        check.expect((await page.locator("section[data-result]").count()) === 0, `${name}: the result closed by the owner does not come back`);
      } else {
        check.expect(last.state === "idle" && last.error?.code === "B_MIGRATION_FAILED" && last.committed === false, `${name}: the updater ended the operation idle with the failure of the migration`, JSON.stringify(last));
        check.expect(seen.result !== "updated", `${name}: the page did not say the update succeeded`);
        // The restore ended the session of the owner; he signs in again and reads what became of it.
        await page.goto(`${origin}/settings/updates`);
        // The page finds out that the session is gone by asking, so the sign-in shows a moment after the page is drawn.
        if (await shows(page.getByLabel(auth["login"].email, { exact: true }), 10_000)) await signIn(page, origin, recoveryCodes[1] ?? "");
        await page.goto(`${origin}/settings/updates`);
        const returned = page.locator('section[data-result="returned"]');
        if (!(await shows(returned, 60_000))) {
          check.expect(false, `${name}: the page shows the result of the way back after the owner signs in again`, `${page.url()}\n${(await page.locator("body").innerText()).slice(0, 1500)}\n${JSON.stringify(await (await context.request.get(`${origin}/api/v1/updates`)).json())}`);
          return;
        }
        const said = await returned.innerText();
        check.expect(said.includes(settings["updates"].result.returned) && said.includes(settings["updates"].result.codes.B_MIGRATION_FAILED), `${name}: the page says in words that the previous version runs on the copy, and why`, said);
        check.expect(await shows(page.getByText(say(settings["updates"].version.current, { version: versionOfA }))), `${name}: the page shows the version of A`);
      }
    } finally {
      await context.close();
    }

    // The side of Docker and of the data, as the two earlier system tests read it.
    const gateFile = path.join(control, "maintenance", "state.json");
    check.expect(JSON.parse(readFileSync(gateFile, "utf8")).activeOperation === null, `${name}: the gate holds no operation`);
    const wanted = outcome === "updated" ? "app-b" : "app-a";
    const pinned = `${pins[wanted]!.repository}@${pins[wanted]!.digest}`;
    const appNow = compose("ps", "-q", "app").stdout.trim();
    check.expect(appNow !== "" && inspectOf(appNow)["Config"].Image === pinned && (await healthy(appNow)), `${name}: the app that runs is ${outcome === "updated" ? "B" : "A"} on its image and is healthy`);
    const apps = run(["ps", "-a", "--filter", `label=com.docker.compose.project=${x.projectName}`, "--filter", "label=com.docker.compose.service=app", "-q"]).stdout.trim().split("\n").filter(Boolean);
    check.expect(apps.length === 1, `${name}: no other app of the project is left`, apps.join(","));
    const file = readReleaseFile(readFileSync(path.join(control, "compose.release.yml"), "utf8"));
    check.expect(file.ok && file.selection.app.digest === pins[wanted]!.digest && file.selection.updater?.digest === pins["updater"]!.digest, `${name}: the release file pins ${outcome === "updated" ? "B" : "A"} and the updater`);
    if (outcome === "returned") check.expect(readFileSync(path.join(control, "compose.release.yml"), "utf8") === fileBefore, `${name}: the release file is as it was`);
    const packages = readdirSync(path.join(x.dir, "data", "backup")).filter((entry) => !entry.startsWith("."));
    check.expect(packages.filter((entry) => entry.includes("-pre_update-")).length === 1, `${name}: there is the copy before the update`, packages.join(","));
    const reader = openDatabase(path.join(x.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
    try {
      const count = (sql: string): number => (reader.handle.prepare(sql).get() as { n: number }).n;
      const migrated = outcome === "updated";
      check.expect(count("SELECT count(*) AS n FROM schema_migration") === PRODUCT_MIGRATION_PLAN.length + (migrated ? 1 : 0) && count("SELECT count(*) AS n FROM sqlite_master WHERE name = 'update_fixture'") === (migrated ? 1 : 0), `${name}: the database is ${migrated ? "migrated to the schema of B" : "the copy's, at the schema of A"}`);
      check.expect(count("SELECT count(*) AS n FROM app_setting WHERE key = 'backup.nightlyKeep'") === 1 && count('SELECT count(*) AS n FROM "user"') === 1, `${name}: the option and the owner are there`);
      check.expect(count("SELECT count(*) AS n FROM audit_log WHERE action = 'update.started'") === 1, `${name}: the start of the update is in the audit log once`);
      if (!migrated) check.expect(count("SELECT count(*) AS n FROM audit_log WHERE action = 'backup.restored'") === 1, `${name}: the restore of the copy is in the audit log once`);
    } finally {
      reader.close();
    }
    check.expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200, `${name}: the health probe says ok`);
    const status = await call("POST", "/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password }, null);
    check.expect(status.status === 200, `${name}: a sign-in, which writes, is taken`);
    // A plain Compose from the folder keeps the release that runs.
    check.expect(compose("up", "-d", "--wait", "--wait-timeout", "120").status === 0, `${name}: a plain docker compose up -d succeeds`);
    check.expect(inspectOf(compose("ps", "-q", "app").stdout.trim())["Config"].Image === pinned, `${name}: after it the app is still ${outcome === "updated" ? "B" : "A"}`);
  }

  try {
    await scenario("forward", "app-b", "updated");
    await scenario("back", "app-broken", "returned");
  } finally {
    await browser.close();
  }
} finally {
  for (const instance of instances) run(["compose", "down", "-v", "--remove-orphans", "-t", "5"], instance.dir);
  run(["rm", "-f", registryName, ...feeds]);
  run(["image", "rm", "-f", TAGS.a, TAGS.b, TAGS.broken, TAGS.updater]);
  for (const dir of copies) removeCopy(dir);
  rmSync(root, { recursive: true, force: true });
}
check.finish();
