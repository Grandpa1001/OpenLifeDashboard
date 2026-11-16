// D52.3 — the release file read by the real Docker Compose (Architektura §11.2.1): the file the updater
// generates is the last file of COMPOSE_FILE of an installation, so `docker compose` from the installation folder
// resolves the app to the image pinned by the digest, and the updater too when the release replaces it, whichever
// process asks and after any number of restarts, since the choice lives in a file and not in a process. The rest of
// the app service (the hardening, the mounts, the environment) is the same as with any other release file.
// The output of `docker compose config` holds the installation keys, so nothing from it is printed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { createCheck } from "../support/check-report.ts";
import { freeLoopbackPort, prepareComposeInstance } from "../support/compose-instance.ts";
import { docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { RELEASE_FILE_NAME, writeReleaseFile } from "../../apps/updater/dist/release/release-file.js";

const { platform } = requireNativeDocker(repoRoot);
const check = createCheck(`the release file read by Docker Compose on ${platform}`);
const probe = docker(["compose", "version", "--short"], repoRoot);
if (probe.status !== 0) {
  check.expect(false, "the docker compose plugin is available", probe.output);
  check.finish();
  process.exit(process.exitCode ?? 1);
}

const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const root = mkdtempSync(path.join(os.tmpdir(), "openlife-release-file-"));
try {
  const instance = prepareComposeInstance(path.join(root, "installation"), { image: "openlife-app:placeholder", port: await freeLoopbackPort() });
  const controlDir = path.join(instance.dir, "control");
  const config = (): JsonObject => {
    const result = docker(["compose", "config", "--format", "json"], instance.dir);
    check.expect(result.status === 0, "docker compose config exits 0 in the installation folder", "(output withheld: it holds the installation keys)");
    try {
      return object(JSON.parse(result.output));
    } catch {
      return {};
    }
  };
  const services = (): JsonObject => object(config()["services"]);
  const without = (service: JsonObject): string => JSON.stringify({ ...service, image: undefined });

  const before = object(services()["app"]);
  check.expect(before["image"] === "openlife-app:placeholder", "before the choice the app is the image of the release file the installer wrote");

  const first = writeReleaseFile(controlDir, { app: { repository: "ghcr.io/owner/openlife-app", digest: DIGEST_A }, updater: null });
  check.expect(first.ok, "the updater writes the choice of the first release", first.ok ? "" : first.code);
  const afterFirst = services();
  const app = object(afterFirst["app"]);
  check.expect(app["image"] === `ghcr.io/owner/openlife-app@${DIGEST_A}`, "a plain docker compose resolves the app to the image pinned by the digest");
  check.expect(without(app) === without(before), "the rest of the app service is what it was: the hardening, the mounts and the environment do not depend on the release");
  check.expect(afterFirst["updater"] === undefined, "an app alone in the choice names no updater");

  const second = writeReleaseFile(controlDir, { app: { repository: "ghcr.io/owner/openlife-app", digest: DIGEST_B }, updater: { repository: "ghcr.io/owner/openlife-updater", digest: DIGEST_B } });
  check.expect(second.ok, "the updater writes the choice of the next release with its own pin");
  const afterSecond = services();
  check.expect(object(afterSecond["app"])["image"] === `ghcr.io/owner/openlife-app@${DIGEST_B}`, "the next choice replaces the app pin");
  check.expect(object(afterSecond["updater"])["image"] === `ghcr.io/owner/openlife-updater@${DIGEST_B}`, "an updater in the choice is pinned by its own digest, separate from the app");

  // The choice is in the file: another process, another run, the same answer.
  check.expect(JSON.stringify(services()) === JSON.stringify(afterSecond), "asked again, as after a restart of the host, Compose gives the same choice");
  check.expect(readFileSync(path.join(controlDir, RELEASE_FILE_NAME), "utf8").includes(DIGEST_B) && !readFileSync(path.join(controlDir, RELEASE_FILE_NAME), "utf8").includes(DIGEST_A), "the file holds the last choice only");
} finally {
  rmSync(root, { recursive: true, force: true });
}
check.finish();
