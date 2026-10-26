// D08.3 — what G0 shows (DEV §8.4): the image of this commit started by Compose from a test
// installation, on this host's native architecture, looked at in a real browser.
// AC1: the image serves the status screen in Polish and English (screenshots in the evidence),
//      health 200, a reloaded UI route, an unknown API path as 404 JSON whose requestId is found
//      in data/logs/app/app.jsonl; the report names the image ID, the container, the Docker
//      version and the architecture it really ran on.
// AC2: in the same installation, a bad configuration and a tampered migration manifest keep the
//      app from ever becoming ready (and change no data); an unwritable log folder only degrades
//      it. Afterwards the installation starts ready again. Not part of G0: auth, the usable setup
//      and the Windows/Safari matrix of KM7 — listed as not_run in the evidence.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { blockCheck, createCheck } from "../support/check-report.ts";
import { freeLoopbackPort, prepareComposeInstance, type ComposeInstance } from "../support/compose-instance.ts";
import { buildAppImage, docker, requireNativeDocker } from "../support/docker.ts";
import { readLog, sha256, waitHealthy } from "../support/installation-state.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-g0";
const READY_TIMEOUT_MS = 90_000;
/** How long a refused start is watched: the restart policy retries it all the while. */
const REFUSAL_WATCH_MS = 15_000;
const LOG_DRAIN_MS = 400;
const NOT_IN_G0 = ["auth and sessions (D09–D13)", "the usable owner setup (D12, D19)", "Windows, Safari and the release matrix (KM7)"];

const { arch, platform, serverVersion } = requireNativeDocker(repoRoot);
if (!existsSync(chromium.executablePath())) {
  blockCheck("the Playwright Chromium browser is not installed (pnpm exec playwright install chromium)");
}
const check = createCheck(`G0: the image of this commit through Compose and a browser on ${platform}`);
if (docker(["compose", "version", "--short"], repoRoot).status !== 0) {
  check.expect(false, "the docker compose plugin is available");
  check.finish();
  process.exit(process.exitCode ?? 1);
}

const text = (value: unknown): string => JSON.stringify(value);
const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const locale = (language: string): JsonObject => object(JSON.parse(readFileSync(path.join(repoRoot, "apps/web/src/locales", language, "common.json"), "utf8")));
const statusText = (language: string, key: "ready" | "unavailable"): string => String(object(object(locale(language)["status"])[key])["heading"]);

const evidenceDir = process.env[EVIDENCE_DIR_ENV];
const root = mkdtempSync(path.join(os.tmpdir(), "openlife-g0-"));
const evidence: Record<string, unknown> = { arch, platform, dockerServer: serverVersion, notInG0: NOT_IN_G0.map((item) => ({ item, status: "not_run" })) };
let installation: ComposeInstance | undefined;
try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    evidence["imageId"] = docker(["image", "inspect", "--format", "{{.Id}}", IMAGE], repoRoot).output.trim();
    const port = await freeLoopbackPort();
    const prepared = prepareComposeInstance(path.join(root, "installation"), { image: IMAGE, port });
    installation = prepared;
    const redact = (value: string): string => prepared.secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), value);
    const compose = (args: readonly string[], timeoutMs = 150_000) => {
      const result = docker(["compose", ...args], prepared.dir, timeoutMs);
      return { status: result.status, output: redact(result.output) };
    };
    const up = () => compose(["up", "--detach", "--wait", "--wait-timeout", "90"]);
    const containerId = (): string => docker(["compose", "ps", "--all", "--quiet", "app"], prepared.dir).output.trim();
    const appLogs = (): string => compose(["logs", "--no-color", "app"]).output;
    const url = (route: string): string => `http://127.0.0.1:${port}${route}`;

    // ---- AC1: the image, ready, seen in a browser.
    const started = up();
    if (check.expect(started.status === 0, "docker compose up --wait: the image of this commit is healthy", started.output)) {
      const inspected = object(JSON.parse(docker(["inspect", containerId()], repoRoot).output)[0]);
      evidence["container"] = { id: containerId(), image: object(inspected["Config"])["Image"], imageId: inspected["Image"], health: object(object(inspected["State"])["Health"])["Status"] };
      check.expect(inspected["Image"] === evidence["imageId"], "the running container uses the image built from this commit", text(evidence["container"]));

      const health = await fetch(url("/api/health"));
      check.expect(health.status === 200 && (await health.text()) === '{"status":"ok"}', "GET /api/health → 200 {\"status\":\"ok\"}");
      const reload = await fetch(url("/settings/app"));
      check.expect(reload.status === 200 && (reload.headers.get("content-type") ?? "").includes("text/html"), "a reloaded UI route gets the SPA document");
      const missing = await fetch(url("/api/g0-missing"));
      const body = object(await missing.json());
      check.expect(missing.status === 404 && body["code"] === "NOT_FOUND" && typeof body["requestId"] === "string", "an unknown API path → 404 JSON NOT_FOUND with a requestId", text(body));
      await pause(LOG_DRAIN_MS);
      const logLine = readLog(prepared.dir).split("\n").find((line) => typeof body["requestId"] === "string" && line.includes(body["requestId"]));
      check.expect(logLine !== undefined && logLine.includes('"status":404'), "the same requestId is in data/logs/app/app.jsonl, with the 404", logLine ?? "");
      evidence["requestId"] = { response: body["requestId"], logLine: logLine ? JSON.parse(logLine) : null };

      const browser = await chromium.launch();
      try {
        for (const language of ["pl", "en"]) {
          const context = await browser.newContext({ locale: language === "pl" ? "pl-PL" : "en-US" });
          const page = await context.newPage();
          await page.goto(url("/"));
          const status = page.getByRole("status");
          await status.getByText(statusText(language, "ready")).waitFor({ timeout: 15_000 }).catch(() => undefined);
          const shown = (await status.textContent()) ?? "";
          check.expect(shown.includes(statusText(language, "ready")), `${language}: the browser shows "${statusText(language, "ready")}"`, shown);
          check.expect((await page.locator("html").getAttribute("lang")) === language && (await page.locator("form, input").count()) === 0, `${language}: page language ${language}, no form`);
          const html = await page.content();
          check.expect(!prepared.secrets.some((secret) => html.includes(secret)) && !html.includes(prepared.dir), `${language}: no installation key or host path in the page`);
          if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, `g0-status-${language}-${arch}.png`) });
          await context.close();
        }
      } finally {
        await browser.close();
      }
    }
    check.expect(compose(["stop"]).status === 0, "docker compose stop");

    // ---- AC2: what keeps the app from becoming ready, and what only degrades it.
    const database = path.join(prepared.dir, "data", "app.db");
    /** Starts without waiting (the restart policy keeps retrying) and watches it never get ready. */
    const refusedStart = async (name: string, code: string): Promise<void> => {
      const before = sha256(database);
      compose(["up", "--detach"]);
      let ready = false;
      const deadline = Date.now() + REFUSAL_WATCH_MS;
      while (Date.now() < deadline && !ready) {
        ready = await fetch(url("/api/health")).then((response) => response.status === 200, () => false);
        await pause(500);
      }
      const logs = appLogs();
      check.expect(!ready && !logs.includes('"bootstrap.ready"'), `${name}: never ready within ${REFUSAL_WATCH_MS / 1000} s`, logs);
      check.expect(logs.includes(`"event":"bootstrap.failed","code":"${code}"`), `${name}: the container log says bootstrap.failed ${code}`, logs);
      compose(["down", "--timeout", "10"]);
      check.expect(sha256(database) === before, `${name}: the database file is unchanged`);
    };

    const envText = readFileSync(prepared.envFile, "utf8");
    writeFileSync(prepared.envFile, envText.replace(/^BASE_URL=.*$/m, "BASE_URL=ftp://localhost:8080"));
    await refusedStart("bad configuration (BASE_URL ftp://)", "CONFIG_INVALID");
    writeFileSync(prepared.envFile, envText);

    const writer = openDatabase(database, { role: "writer", busyTimeoutMs: 5000 });
    const [applied] = writer.handle.prepare("SELECT checksum FROM schema_migration WHERE version = 1").pluck().all() as string[];
    writer.handle.prepare("UPDATE schema_migration SET checksum = ? WHERE version = 1").run("0".repeat(64));
    writer.close();
    await refusedStart("tampered migration checksum", "MIGRATION_CHECKSUM_MISMATCH");
    const restore = openDatabase(database, { role: "writer", busyTimeoutMs: 5000 });
    restore.handle.prepare("UPDATE schema_migration SET checksum = ? WHERE version = 1").run(applied);
    restore.close();

    const logs = path.join(prepared.dir, "data", "logs", "app");
    chmodSync(logs, 0o555);
    try {
      const degraded = up();
      const containerLog = appLogs();
      check.expect(degraded.status === 0 && (await waitHealthy(port, READY_TIMEOUT_MS)), "unwritable log folder: the app still becomes healthy", degraded.output);
      check.expect(containerLog.includes('"event":"bootstrap.degraded","code":"LOG_SINK_UNAVAILABLE"'), "unwritable log folder: bootstrap.degraded LOG_SINK_UNAVAILABLE", containerLog);
      compose(["stop"]);
    } finally {
      chmodSync(logs, 0o755);
    }

    const again = up();
    check.expect(again.status === 0 && (await waitHealthy(port, READY_TIMEOUT_MS)), "with all of it repaired the same installation is ready again", again.output);
    const ready = appLogs().split("\n").filter((line) => line.includes('"bootstrap.ready"')).at(-1) ?? "";
    check.expect(ready.includes('"created":false'), "it is the existing installation, not a new one", ready);
  }
} finally {
  if (installation) docker(["compose", "down", "--timeout", "10"], installation.dir);
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  rmSync(root, { recursive: true, force: true });
  if (evidenceDir) writeFileSync(path.join(evidenceDir, `g0-image-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
check.finish();
