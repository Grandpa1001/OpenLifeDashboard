// D02.3 — the app container on this host's native architecture.
// AC1: health, SPA reload and API 404 through the published port, Docker HEALTHCHECK reports
//      healthy, and `docker stop` (SIGTERM) ends the only process with exit code 0 in time.
// AC2: an invalid start argument exits nonzero with a readable stderr message.
// Both architectures are covered by running this on linux/amd64 and linux/arm64 hosts (CI).
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { buildAppImage, containerInstanceArgs, docker, hostTestInstance, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";
import type { TestInstance } from "../support/test-instance.ts";

const IMAGE = "openlife-app:verify-d02-lifecycle";
const CONTAINER = `openlife-d02-${randomBytes(4).toString("hex")}`;
/** Docker waits this long after SIGTERM before SIGKILL; the app limit is 15 s (Architektura §15.2). */
const STOP_GRACE_SECONDS = 20;
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

type HttpResult = Readonly<{ path: string; status: number; contentType: string | null; body: string }>;

async function get(baseUrl: string, requestPath: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${requestPath}`);
  return { path: requestPath, status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

function inspectState(): Record<string, unknown> {
  const state = docker(["inspect", "--format", "{{json .State}}", CONTAINER], repoRoot);
  try {
    const value: unknown = JSON.parse(state.output);
    return isJsonObject(value) ? { ...value } : {};
  } catch {
    return {};
  }
}

const { arch, platform, serverVersion } = requireNativeDocker(repoRoot);
const evidence: Record<string, unknown> = { arch, platform, dockerServerVersion: serverVersion };
const check = createCheck(`app container lifecycle on ${platform} (native)`);
let instance: TestInstance | undefined;
const expected = process.env["OPENLIFE_EXPECT_ARCH"];
if (expected) {
  check.expect(expected === arch, `runner architecture is the expected ${expected} (got ${arch})`);
}

try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    // D02.3-AC1: start, serve, report healthy.
    // Since D03.4 the server boots only with an installation environment and instance.json.
    instance = hostTestInstance();
    const run = docker(
      ["run", "--detach", "--name", CONTAINER, "--platform", platform, "--publish", "127.0.0.1::8080", ...containerInstanceArgs(instance), IMAGE],
      repoRoot,
    );
    check.expect(run.status === 0, "container starts detached", run.output);
    const mapping = docker(["port", CONTAINER, "8080/tcp"], repoRoot).output.trim().split("\n")[0] ?? "";
    const hostPort = /:(\d+)$/.exec(mapping)?.[1];
    check.expect(Boolean(hostPort) && mapping.startsWith("127.0.0.1:"), `port 8080 is published on loopback only (${mapping})`);
    const baseUrl = `http://127.0.0.1:${hostPort}`;

    const health = await waitFor(async () => {
      try {
        const result = await get(baseUrl, "/api/health");
        return result.status === 200 ? result : undefined;
      } catch {
        return undefined;
      }
    }, READY_TIMEOUT_MS);
    const responses = health ? [health, await get(baseUrl, "/main"), await get(baseUrl, "/api/nope"), await get(baseUrl, "/assets/missing.js")] : [];
    evidence["responses"] = responses;
    check.expect(health?.body === '{"status":"ok"}', "AC1: GET /api/health → 200 {\"status\":\"ok\"}", docker(["logs", CONTAINER], repoRoot).output);
    const [, spa, apiMissing, assetMissing] = responses;
    check.expect(spa?.status === 200 && /^text\/html/i.test(spa.contentType ?? ""), "AC1: reload of /main → 200 HTML");
    check.expect(
      apiMissing?.status === 404 && /^application\/json/.test(apiMissing.contentType ?? "") && apiMissing.body.includes('"NOT_FOUND"'),
      "AC1: unknown /api path → 404 JSON NOT_FOUND",
    );
    check.expect(assetMissing?.status === 404 && !/html/i.test(assetMissing.contentType ?? ""), "AC1: missing asset → 404 without the SPA");

    const healthStatus = await waitFor(() => {
      const status = inspectState()["Health"];
      const value = isJsonObject(status) ? status["Status"] : undefined;
      return value === "healthy" || value === "unhealthy" ? String(value) : undefined;
    }, READY_TIMEOUT_MS);
    evidence["healthcheck"] = healthStatus ?? "no result";
    check.expect(healthStatus === "healthy", `AC1: Docker HEALTHCHECK reports healthy (got ${healthStatus ?? "no result"})`);

    // `args`, not `comm`: Node names its main thread "MainThread", which `comm` reports.
    const processes = docker(["top", CONTAINER, "-o", "pid,args"], repoRoot).output.trim().split("\n").slice(1);
    evidence["processes"] = processes;
    check.expect(
      processes.length === 1 && /\bnode apps\/server\/dist\/main\.js\b/.test(processes[0] ?? ""),
      `AC1: the server is the only process (${processes.join("; ")})`,
    );

    // D02.3-AC1: SIGTERM via docker stop must end the process before Docker would SIGKILL it.
    const stopStarted = Date.now();
    const stop = docker(["stop", "--time", String(STOP_GRACE_SECONDS), CONTAINER], repoRoot, (STOP_GRACE_SECONDS + 30) * 1000);
    const stopMs = Date.now() - stopStarted;
    const state = inspectState();
    const logs = docker(["logs", CONTAINER], repoRoot).output;
    evidence["stop"] = { durationMs: stopMs, exitCode: state["ExitCode"], oomKilled: state["OOMKilled"], logTail: logs.trim().split("\n").slice(-3) };
    check.expect(stop.status === 0 && state["Running"] === false, "AC1: docker stop ends the container", stop.output);
    check.expect(state["ExitCode"] === 0, `AC1: exit code after SIGTERM is 0 (got ${String(state["ExitCode"])})`, logs);
    check.expect(stopMs < STOP_GRACE_SECONDS * 1000, `AC1: stopped in ${stopMs} ms, before the SIGKILL deadline`);
    check.expect(logs.includes('"event":"server.stopped"'), "AC1: the server logged an orderly stop", logs);

    // D02.3-AC2: invalid start arguments.
    const invalidStarts: unknown[] = [];
    evidence["invalidStarts"] = invalidStarts;
    for (const args of [["--port", "abc"], ["--unknown-flag", "1"]]) {
      const bad = docker(["run", "--rm", "--platform", platform, IMAGE, ...args], repoRoot);
      invalidStarts.push({ args, exitCode: bad.status, output: bad.output.trim() });
      check.expect(
        bad.status === 1 && bad.output.includes("openlife server:"),
        `AC2: start with ${args.join(" ")} exits 1 with a readable message (${bad.output.trim()})`,
      );
    }
  }
} finally {
  if (instance) {
    rmSync(path.dirname(instance.dir), { recursive: true, force: true });
  }
  docker(["rm", "--force", CONTAINER], repoRoot);
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, `container-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
