// A clean Linux for the installer tests (DEV D58.4, D60.4): a container of Ubuntu 24.04 with its own Docker daemon (the packages of the
// distribution, a user that is not root). The application image reaches that daemon through a registry that runs in it, so that a
// release package can pin a digest, and the package of the version is unpacked there. The tests then run install.sh as a user would.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReleasePackage } from "../../scripts/support/release-package.ts";
import type { Check } from "./check-report.ts";
import { buildAppImage, docker, requireNativeDocker } from "./docker.ts";
import { repoRoot } from "./repository-copy.ts";

const REGISTRY_IMAGE = "registry:2";
const REPOSITORY = "registry.test/openlife/app";
const VERSION = "1.4.0";
export const HOME = "/home/tester";

export type Run = Readonly<{ status: number | null; output: string; stdout: string }>;

export type CleanLinux = Readonly<{
  arch: string;
  platform: string;
  /** The folder of the unpacked package. */
  folder: string;
  /** The image the package pins, `registry.test/openlife/app@sha256:...`. */
  image: string;
  /** The facts of the box for the evidence. */
  facts: Readonly<Record<string, unknown>>;
  /** A command of the host. */
  host: (args: readonly string[], timeoutMs?: number) => Run;
  /** Copies a file or folder of the host into the box (as root; `inside` with `root` can chown it). */
  copyIn: (from: string, to: string) => Run;
  /** A command in the clean Linux as `tester` (or root), with an optional stdin and environment. */
  inside: (command: readonly string[], options?: Readonly<{ input?: string; root?: boolean; timeoutMs?: number; env?: Readonly<Record<string, string>> }>) => Run;
  insideDocker: (args: readonly string[]) => Run;
  read: (file: string) => string;
  stageOf: (dir: string) => string;
  /** Runs install.sh of the package. */
  installFrom: (args: readonly string[], input?: string, env?: Readonly<Record<string, string>>) => Run;
  waitFor: (what: string, probe: () => boolean, seconds?: number) => Promise<boolean>;
}>;

export type CleanLinuxOptions = Readonly<{
  /** A name that keeps the images and the container of one test apart from another's. */
  name: string;
  /** Names that resolve to the box itself (--add-host), e.g. a domain for the server mode. */
  hosts?: readonly string[];
}>;

/** Starts the box, loads the images, builds the package and calls `body`; the box and its images are removed afterwards. */
export async function withCleanLinux(check: Check, options: CleanLinuxOptions, body: (box: CleanLinux) => Promise<void>): Promise<void> {
  const { arch, platform } = requireNativeDocker(repoRoot);
  const appImage = `openlife-app:verify-${options.name}`;
  const boxImage = `openlife-clean-linux:verify-${options.name}`;
  const box = `openlife-clean-linux-${options.name}-${process.pid}`;
  const volume = `${box}-docker`;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-clean-linux-"));

  const host: CleanLinux["host"] = (args, timeoutMs = 15 * 60 * 1000) => {
    const result = docker(args, repoRoot, timeoutMs);
    return { status: result.status, output: result.output, stdout: result.output };
  };
  const inside: CleanLinux["inside"] = (command, opts = {}) => {
    const env = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const result = spawnSync("docker", ["exec", "-i", ...env, ...(opts.root ? [] : ["-u", "tester", "-w", HOME]), box, ...command], {
      input: opts.input ?? "",
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
  };
  const insideDocker: CleanLinux["insideDocker"] = (args) => inside(["docker", ...args]);
  const read = (file: string): string => inside(["cat", file]).stdout;
  const stageOf = (dir: string): string => /"stage":\s*"([a-z]+)"/.exec(read(`${dir}/control/install-state.json`))?.[1] ?? "";
  const waitFor: CleanLinux["waitFor"] = async (what, probe, seconds = 90) => {
    for (let waited = 0; waited < seconds; waited += 1) {
      if (probe()) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    check.expect(false, `${what} did not become ready in ${seconds} s`);
    return false;
  };

  try {
    const appBuild = buildAppImage(appImage, platform, repoRoot);
    const boxBuild = host(["build", "-t", boxImage, path.join(repoRoot, "tests", "system", "clean-linux")]);
    const registryHere = host(["image", "inspect", REGISTRY_IMAGE]).status === 0 || host(["pull", REGISTRY_IMAGE]).status === 0;
    if (
      !check.expect(appBuild.status === 0, `docker build --platform ${platform} of the application exits 0`, appBuild.output) ||
      !check.expect(boxBuild.status === 0, "the image of the clean Ubuntu with Docker is built", boxBuild.output) ||
      !check.expect(registryHere, "the image of the registry is on this computer")
    ) {
      return;
    }
    const addHosts = ["registry.test", "tester.test", ...(options.hosts ?? [])].flatMap((name) => ["--add-host", `${name}:127.0.0.1`]);
    const started = host(["run", "-d", "--privileged", "--name", box, ...addHosts, "-v", `${volume}:/var/lib/docker`, boxImage]);
    check.expect(started.status === 0, "the clean Linux starts (privileged, with a Docker daemon of its own)", started.output);
    if (!(await waitFor("the Docker daemon of the clean Linux", () => insideDocker(["info"]).status === 0))) return;

    const versions = insideDocker(["version", "--format", "{{.Server.Version}} compose {{.Client.Version}}"]).stdout.trim();
    const os_ = inside(["sh", "-c", ". /etc/os-release && echo $PRETTY_NAME && id -u"]).stdout.trim().split("\n");
    check.expect(os_[0]?.startsWith("Ubuntu") === true && os_[1] !== "0", "the installer runs as a user that is not root, on Ubuntu", os_.join(" | "));
    const facts = { os: os_[0], docker: versions, compose: inside(["docker", "compose", "version", "--short"]).stdout.trim() };

    // The application image reaches the daemon of the clean Linux through a registry that runs there, so the package can pin a digest.
    for (const image of [appImage, REGISTRY_IMAGE]) {
      const loaded = spawnSync("sh", ["-c", `docker save ${image} | docker exec -i ${box} docker load`], { encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      check.expect(loaded.status === 0, `${image} is loaded into the daemon of the clean Linux`, `${loaded.stdout}${loaded.stderr}`);
    }
    const registry = insideDocker(["run", "-d", "--name", "registry", "-p", "127.0.0.1:80:5000", REGISTRY_IMAGE]);
    check.expect(registry.status === 0, "a registry runs on port 80 of the clean Linux", registry.output);
    await waitFor("the registry", () => inside(["curl", "-fsS", "http://registry.test/v2/"]).status === 0);
    const tagged = insideDocker(["tag", appImage, `${REPOSITORY}:${VERSION}`]);
    const pushed = insideDocker(["push", `${REPOSITORY}:${VERSION}`]);
    check.expect(tagged.status === 0 && pushed.status === 0, "the application image is pushed to the registry", `${tagged.output}${pushed.output}`);
    const digest = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.output)?.[1] ?? "";
    const image = `${REPOSITORY}@${digest}`;
    check.expect(/^registry\.test\/openlife\/app@sha256:[0-9a-f]{64}$/.test(image), "the image has a digest in the registry", image);
    // The image is pulled by the installer, not found on the computer: the local copies are removed.
    insideDocker(["image", "rm", "--force", `${REPOSITORY}:${VERSION}`, appImage]);

    const built = buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(scratch, "package"), version: VERSION, image });
    const copied = host(["cp", built.archive, `${box}:/tmp/package.tar.gz`]);
    check.expect(copied.status === 0, "the archive of the package is copied to the clean Linux", copied.output);
    check.expect(inside(["tar", "-xzf", "/tmp/package.tar.gz", "-C", HOME]).status === 0, "the archive is unpacked as the user");
    const folder = `${HOME}/openlife-dashboard-${VERSION}`;

    await body({
      arch,
      platform,
      folder,
      image,
      facts,
      host,
      copyIn: (from, to) => host(["cp", from, `${box}:${to}`]),
      inside,
      insideDocker,
      read,
      stageOf,
      installFrom: (args, input, env) => inside(["bash", `${folder}/install.sh`, ...args], { ...(input === undefined ? {} : { input }), ...(env === undefined ? {} : { env }) }),
      waitFor,
    });
  } finally {
    host(["rm", "--force", box]);
    host(["volume", "rm", "--force", volume]);
    host(["image", "rm", "--force", appImage, boxImage]);
    rmSync(scratch, { recursive: true, force: true });
  }
}
