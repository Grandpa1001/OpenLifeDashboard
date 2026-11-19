// D61.1 — the publication of the two images with a real Docker daemon and a registry of its own (DEV §9.60, Architektura Załącznik I).
// `scripts/publish-images.ts build` builds the app and the updater for the architecture of this computer and pushes them under the tag
// of that architecture; `merge` joins them into the index of the version and writes the pinned names. Checked on what the registry holds:
// the digests are the registry's, the index lists the architecture, the app run from its digest answers and reports the revision and the
// version it was given, the updater image holds the updater; and what the script refuses before it builds anything. The real two-architecture
// run on two runners and GHCR is the workflow (tests of its file are D61.1-AC2 and D61.4).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isJsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort } from "../support/compose-instance.ts";
import { containerInstanceArgs, docker, hostTestInstance, requireNativeDocker } from "../support/docker.ts";
import { PRODUCT_VERSION_PATTERN } from "../support/product-version.ts";
import { repoRoot } from "../support/repository-copy.ts";

const REGISTRY_IMAGE = "registry:2";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const VERSION = (JSON.parse(readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8")) as { version: string }).version;
const PUBLISH = path.join(repoRoot, "scripts/publish-images.ts");
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`publication of the images on ${platform}`);
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-publish-test-"));
const registryName = `openlife-publish-registry-${process.pid}`;
const evidence: Record<string, unknown> = { arch, platform };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** The script to its end: a build of two images takes minutes on a runner, which the 25 s of the helper for the commands of the server would cut. */
const script = (args: readonly string[]): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PUBLISH, ...args], { cwd: repoRoot, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const timer = setTimeout(() => (child.kill("SIGKILL"), reject(new Error(`the script ran longer than ${BUILD_TIMEOUT_MS} ms:\n${output}`))), BUILD_TIMEOUT_MS);
    child.once("error", reject);
    child.once("exit", (code) => (clearTimeout(timer), resolve({ code, output })));
  });

let appContainer: string | undefined;
try {
  const port = await freeLoopbackPort();
  if (docker(["image", "inspect", REGISTRY_IMAGE], repoRoot).status !== 0) docker(["pull", REGISTRY_IMAGE], repoRoot);
  const started = docker(["run", "-d", "--rm", "--name", registryName, "-p", `127.0.0.1:${port}:5000`, REGISTRY_IMAGE], repoRoot);
  if (!check.expect(started.status === 0, "a registry runs on this computer", started.output)) throw new Error("no registry");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/v2/`).catch(() => undefined))?.status === 200) break;
    await sleep(250);
  }
  const registry = `localhost:${port}/openlife`;
  const common = ["--registry", registry, "--version", VERSION, "--revision", REVISION];
  const builtFile = path.join(scratch, "built.json");
  const publishedFile = path.join(scratch, "published.json");

  // ---- What is refused before anything is built.
  const refusals: ReadonlyArray<readonly [string, readonly string[], RegExp]> = [
    ["a version that is not x.y.z", ["build", "--registry", registry, "--version", "1.0", "--revision", REVISION, "--platform", platform, "--out", builtFile], /version must be x\.y\.z/],
    ["a version that is not the one of the packages", ["build", "--registry", registry, "--version", "9.9.9", "--revision", REVISION, "--platform", platform, "--out", builtFile], new RegExp(`package\\.json has the version ${PRODUCT_VERSION_PATTERN}, not 9\\.9\\.9`)],
    ["a revision that is not a commit", ["build", "--registry", registry, "--version", VERSION, "--revision", "main", "--platform", platform, "--out", builtFile], /revision must be 7 to 40 hex/],
    ["a registry with upper case letters", ["build", "--registry", "ghcr.io/Owner", "--version", VERSION, "--revision", REVISION, "--platform", platform, "--out", builtFile], /registry must be lower case/],
    ["a registry without an owner", ["build", "--registry", "ghcr.io", "--version", VERSION, "--revision", REVISION, "--platform", platform, "--out", builtFile], /registry must be lower case/],
    ["an architecture that is not supported", ["build", ...common, "--platform", "linux/s390x", "--out", builtFile], /platform must be linux\/amd64 or linux\/arm64/],
    ["no output file", ["build", ...common, "--platform", platform], /--out is required/],
  ];
  for (const [name, args, message] of refusals) {
    const run = await script(args);
    check.expect(run.code === 1 && message.test(run.output), `${name} is refused before anything is built`, run.output);
  }

  // ---- Build and push one architecture.
  const build = await script(["build", ...common, "--platform", platform, "--out", builtFile]);
  if (!check.expect(build.code === 0, `build pushes the app and the updater for ${platform}`, build.output)) throw new Error("no build");
  const built = JSON.parse(readFileSync(builtFile, "utf8")) as { platform: string; digests: { app: string; updater: string } };
  check.expect(built.platform === platform && /^sha256:[0-9a-f]{64}$/.test(built.digests.app) && /^sha256:[0-9a-f]{64}$/.test(built.digests.updater) && built.digests.app !== built.digests.updater, "it reports the digests of the two images", JSON.stringify(built));
  const tags = async (name: string): Promise<string[]> => ((await (await fetch(`http://127.0.0.1:${port}/v2/openlife/${name}/tags/list`)).json()) as { tags: string[] }).tags;
  check.expect((await tags("openlifedashboard")).includes(`${VERSION}-${arch}`) && (await tags("openlifedashboard-updater")).includes(`${VERSION}-${arch}`), "the registry holds both images under the tag of the architecture");

  // ---- Join into the index of the version.
  const duplicate = path.join(scratch, "built-again.json");
  writeFileSync(duplicate, readFileSync(builtFile));
  const twice = await script(["merge", ...common, "--out", publishedFile, builtFile, duplicate]);
  check.expect(twice.code === 1 && /architecture is given twice/.test(twice.output), "the same architecture twice is refused", twice.output);
  const badDigest = path.join(scratch, "built-bad.json");
  writeFileSync(badDigest, JSON.stringify({ platform, digests: { app: "sha256:short", updater: built.digests.updater } }));
  const bad = await script(["merge", ...common, "--out", publishedFile, badDigest]);
  check.expect(bad.code === 1 && /is not sha256:<64 hex>/.test(bad.output), "a digest that is not sha256 and 64 hex digits is refused", bad.output);
  const merge = await script(["merge", ...common, "--out", publishedFile, builtFile]);
  if (!check.expect(merge.code === 0, "merge joins the architectures into the index of the version", merge.output)) throw new Error("no merge");
  const published = JSON.parse(readFileSync(publishedFile, "utf8")) as { version: string; buildRevision: string; app: string; updater: string };
  evidence["published"] = published;
  const pinned = /^localhost:\d+\/openlife\/(openlifedashboard(?:-updater)?)@(sha256:[0-9a-f]{64})$/;
  check.expect(published.version === VERSION && published.buildRevision === REVISION && pinned.test(published.app) && pinned.test(published.updater), "the result names both images pinned by the digest of their index", JSON.stringify(published));
  for (const [key, name] of [["app", published.app], ["updater", published.updater]] as const) {
    const inspected = docker(["buildx", "imagetools", "inspect", name, "--format", "{{json .Manifest}}"], repoRoot);
    const manifest = isJsonObject(JSON.parse(inspected.output || "{}")) ? (JSON.parse(inspected.output) as { mediaType?: string; manifests?: { platform?: { architecture?: string } }[] }) : {};
    const architectures = (manifest.manifests ?? []).map((entry) => entry.platform?.architecture);
    check.expect(inspected.status === 0 && /index|manifest\.list/.test(manifest.mediaType ?? "") && architectures.includes(arch), `the ${key} digest is an index that lists ${arch}`, inspected.output);
  }
  check.expect((await tags("openlifedashboard")).includes(VERSION) && (await tags("openlifedashboard-updater")).includes(VERSION), "the registry holds the tag of the version on both");

  // ---- The app image, run from its digest.
  const pulled = docker(["pull", published.app], repoRoot, 10 * 60 * 1000);
  check.expect(pulled.status === 0, "the app image is pulled by its digest", pulled.output);
  const catted = (image: string, file: string) => docker(["run", "--rm", "--entrypoint", "cat", image, file], repoRoot);
  const buildInfo = catted(published.app, "apps/server/build-info.json").output.trim();
  const reported = catted(published.app, "apps/server/package.json").output;
  check.expect(buildInfo === `{"buildRevision":"${REVISION}"}`, "the app image carries the revision it was given", buildInfo);
  check.expect((JSON.parse(reported) as { version: string }).version === VERSION, "and the version of the release", VERSION);
  const instance = hostTestInstance();
  const hostPort = await freeLoopbackPort();
  const first = docker(["run", "--rm", "--platform", platform, ...containerInstanceArgs(instance), "--entrypoint", "node", published.app, "apps/server/dist/cli/config-check.js"], repoRoot);
  check.expect(first.status === 0, "the app image accepts its environment", first.output);
  const run = docker(["run", "-d", "--platform", platform, ...containerInstanceArgs(instance), "-p", `127.0.0.1:${hostPort}:8080`, published.app], repoRoot);
  appContainer = run.output.trim().split("\n").pop();
  let healthy = false;
  for (let attempt = 0; attempt < 120 && !healthy; attempt += 1) {
    healthy = (await fetch(`http://127.0.0.1:${hostPort}/api/health`).catch(() => undefined))?.status === 200;
    if (!healthy) await sleep(500);
  }
  check.expect(healthy, "the app started from its digest answers 200 on /api/health", docker(["logs", appContainer ?? ""], repoRoot).output);

  // ---- The updater image.
  docker(["pull", published.updater], repoRoot, 10 * 60 * 1000);
  const updaterInfo = docker(["image", "inspect", published.updater, "--format", "{{json .Config.Entrypoint}}|{{.Config.User}}"], repoRoot);
  check.expect(updaterInfo.status === 0 && updaterInfo.output.trim() === '["node","apps/updater/dist/main.js"]|node', "the updater image starts the updater as the user node", updaterInfo.output);
  const main = docker(["run", "--rm", "--entrypoint", "ls", published.updater, "apps/updater/dist/main.js"], repoRoot);
  check.expect(main.status === 0, "and holds its code", main.output);
  const noApp = docker(["run", "--rm", "--entrypoint", "ls", published.updater, "apps/server"], repoRoot);
  check.expect(noApp.status !== 0, "and none of the code of the app");
} catch (error) {
  check.expect(false, "the check ran to its end", error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  if (appContainer) docker(["rm", "--force", appContainer], repoRoot);
  docker(["rm", "--force", registryName], repoRoot);
  rmSync(scratch, { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, `publish-images-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
