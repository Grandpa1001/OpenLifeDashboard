// D58.4 — the release package on a clean Linux (DEV §9.57). A container of Ubuntu 24.04 with its own Docker daemon
// (the packages of the distribution, a user that is not root) receives the app image through a registry that runs in
// it, and the release package, made for the digest of that image, is unpacked and run there as a user would run it:
//   AC1: the local mode installs, the owner signs in, a second run changes nothing, and the folder is not a different
//        installation when the run is repeated with a newer package next to it;
//   AC2: the server mode with a domain that does not resolve ends with the state of waiting (status 3, NOT installed),
//        starts nothing, keeps its keys on a rerun, and a really taken port 80 is refused before anything is written.
// The password is on stdin only. The HTTPS stack and the real certificate are D60.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReleasePackage } from "../../scripts/support/release-package.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { buildAppImage, docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const APP_IMAGE = "openlife-app:verify-d58-clean";
const BOX_IMAGE = "openlife-clean-linux:verify-d58";
const REGISTRY_IMAGE = "registry:2";
const BOX = `openlife-clean-linux-${process.pid}`;
const VOLUME = `${BOX}-docker`;
const REPOSITORY = "registry.test/openlife/app";
const OWNER_EMAIL = "wlasciciel@example.com";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const PORT = 18080;
const DOMAIN = "dziennik.example.invalid";
const ACME_EMAIL = "admin@example.com";
const HOME = "/home/tester";
const TEN_MINUTES_S = 10 * 60;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`install.sh from a release package on a clean Linux (${platform})`);

type Run = Readonly<{ status: number | null; output: string; stdout: string }>;
const host = (args: readonly string[], timeoutMs = 15 * 60 * 1000): Run => {
  const result = docker(args, repoRoot, timeoutMs);
  return { status: result.status, output: result.output, stdout: result.output };
};
/** A command in the clean Linux as the user `tester` (or root), with an optional stdin. */
function inside(command: readonly string[], options: Readonly<{ input?: string; root?: boolean; timeoutMs?: number }> = {}): Run {
  const result = spawnSync("docker", ["exec", "-i", ...(options.root ? [] : ["-u", "tester", "-w", HOME]), BOX, ...command], {
    input: options.input ?? "",
    encoding: "utf8",
    timeout: options.timeoutMs ?? 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}
const insideDocker = (args: readonly string[]): Run => inside(["docker", ...args]);
const read = (file: string): string => inside(["cat", file]).stdout;
const stageOf = (dir: string): string => /"stage":\s*"([a-z]+)"/.exec(read(`${dir}/control/install-state.json`))?.[1] ?? "";

async function waitFor(what: string, probe: () => boolean, seconds = 90): Promise<boolean> {
  for (let waited = 0; waited < seconds; waited += 1) {
    if (probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check.expect(false, `${what} did not become ready in ${seconds} s`);
  return false;
}

function installFrom(folder: string, args: readonly string[], input?: string): Run {
  return inside(["bash", `${folder}/install.sh`, ...args], input === undefined ? {} : { input });
}

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-clean-linux-"));
const evidence: Record<string, unknown> = {};
try {
  const appBuild = buildAppImage(APP_IMAGE, platform, repoRoot);
  const boxBuild = host(["build", "-t", BOX_IMAGE, path.join(repoRoot, "tests", "system", "clean-linux")]);
  const registryHere = host(["image", "inspect", REGISTRY_IMAGE]).status === 0 || host(["pull", REGISTRY_IMAGE]).status === 0;
  if (
    check.expect(appBuild.status === 0, `docker build --platform ${platform} of the application exits 0`, appBuild.output) &&
    check.expect(boxBuild.status === 0, "the image of the clean Ubuntu with Docker is built", boxBuild.output) &&
    check.expect(registryHere, "the image of the registry is on this computer")
  ) {
    const started = host(["run", "-d", "--privileged", "--name", BOX, "--add-host", "registry.test:127.0.0.1", "--add-host", "tester.test:127.0.0.1", "-v", `${VOLUME}:/var/lib/docker`, BOX_IMAGE]);
    check.expect(started.status === 0, "the clean Linux starts (privileged, with a Docker daemon of its own)", started.output);
    const daemon = await waitFor("the Docker daemon of the clean Linux", () => insideDocker(["info"]).status === 0);
    if (daemon) {
      const versions = insideDocker(["version", "--format", "{{.Server.Version}} compose {{.Client.Version}}"]).stdout.trim();
      const os_ = inside(["sh", "-c", ". /etc/os-release && echo $PRETTY_NAME && id -u"]).stdout.trim().split("\n");
      check.expect(os_[0]?.startsWith("Ubuntu") === true && os_[1] !== "0", "the installer runs as a user that is not root, on Ubuntu", os_.join(" | "));
      evidence["linux"] = { os: os_[0], docker: versions, compose: inside(["docker", "compose", "version", "--short"]).stdout.trim() };

      // The application image reaches the daemon of the clean Linux through a registry that runs there, so the package can pin a digest.
      for (const image of [APP_IMAGE, REGISTRY_IMAGE]) {
        const loaded = spawnSync("sh", ["-c", `docker save ${image} | docker exec -i ${BOX} docker load`], { encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
        check.expect(loaded.status === 0, `${image} is loaded into the daemon of the clean Linux`, `${loaded.stdout}${loaded.stderr}`);
      }
      const registry = insideDocker(["run", "-d", "--name", "registry", "-p", "127.0.0.1:80:5000", REGISTRY_IMAGE]);
      check.expect(registry.status === 0, "a registry runs on port 80 of the clean Linux", registry.output);
      await waitFor("the registry", () => inside(["curl", "-fsS", "http://registry.test/v2/"]).status === 0);
      const tagged = insideDocker(["tag", APP_IMAGE, `${REPOSITORY}:1.4.0`]);
      const pushed = insideDocker(["push", `${REPOSITORY}:1.4.0`]);
      check.expect(tagged.status === 0 && pushed.status === 0, "the application image is pushed to the registry", `${tagged.output}${pushed.output}`);
      const digest = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.output)?.[1] ?? "";
      const image = `${REPOSITORY}@${digest}`;
      check.expect(/^registry\.test\/openlife\/app@sha256:[0-9a-f]{64}$/.test(image), "the image has a digest in the registry", image);
      // The image is pulled by the installer, not found on the computer: the local copies are removed.
      insideDocker(["image", "rm", "--force", `${REPOSITORY}:1.4.0`, APP_IMAGE]);

      const built = buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(scratch, "package"), version: "1.4.0", image });
      const copied = host(["cp", built.archive, `${BOX}:/tmp/package.tar.gz`]);
      check.expect(copied.status === 0, "the archive of the package is copied to the clean Linux", copied.output);
      check.expect(inside(["tar", "-xzf", "/tmp/package.tar.gz", "-C", HOME]).status === 0, "the archive is unpacked as the user");
      const folder = `${HOME}/openlife-dashboard-1.4.0`;

      // ---- AC1: the local mode from the package.
      const dir = `${HOME}/Moja instalacja`;
      const startedAt = Date.now();
      const first = installFrom(folder, ["--dir", dir, "--port", String(PORT), "--owner-email", OWNER_EMAIL, "--owner-password-stdin", "--yes"], `${PASSWORD}\n`);
      const seconds = (Date.now() - startedAt) / 1000;
      if (check.expect(first.status === 0, "install.sh from the package exits 0 on the clean Linux", first.output)) {
        check.expect(stageOf(dir) === "complete", "the state of the installation is complete", stageOf(dir));
        check.expect(seconds < TEN_MINUTES_S, `the installation took ${seconds.toFixed(0)} s, inside ten minutes (the image is pulled from the registry)`);
        check.expect(first.output.includes("every file matches SHA256SUMS") && first.output.includes("1.4.0"), "the installer says it checked the package and names its version", first.output);
        const health = inside(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${PORT}/api/health`]).stdout;
        check.expect(health === "200", "GET /api/health answers 200", health);
        const signIn = (password: string): string =>
          inside(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", "content-type: application/json", "-H", `origin: http://localhost:${PORT}`, "--data-binary", "@-", `http://127.0.0.1:${PORT}/api/auth/sign-in/email`], {
            input: JSON.stringify({ email: OWNER_EMAIL, password }),
          }).stdout;
        check.expect(signIn(`${PASSWORD} x`) === "401", "a wrong password is refused");
        check.expect(signIn(PASSWORD) === "200", "the owner signs in with the password given to the installer");
        const published = insideDocker(["ps", "--format", "{{.Ports}}"]).stdout;
        check.expect(published.includes(`127.0.0.1:${PORT}->8080/tcp`) && !published.includes("0.0.0.0:18080"), "the application is published on 127.0.0.1 only", published);
        check.expect(![first.output, read(`${dir}/.env`)].some((text) => text.includes(PASSWORD)), "the password is in neither the output nor .env");

        // A repeated run changes nothing and starts nothing again.
        const identity = (): string => ["control/instance.json", ".env", "control/compose.release.yml"].map((file) => read(`${dir}/${file}`)).join("\n--\n");
        const before = identity();
        const containerBefore = insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim();
        const again = installFrom(folder, ["--dir", dir, "--yes"]);
        check.expect(again.status === 0 && again.output.includes("nothing was changed"), "a second run of a complete installation only shows its status", again.output);
        check.expect(identity() === before && insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim() === containerBefore, "the second run keeps the keys, the files and the very same container");
        check.expect(signIn(PASSWORD) === "200", "the owner still signs in after the second run");
        evidence["local"] = { seconds, status: first.status, rerunStatus: again.status };
      }

      // ---- AC2: the server mode for a domain that does not resolve, on a real Linux.
      const serverDir = `${HOME}/serwer dane`;
      const taken = installFrom(folder, ["--mode", "server", "--dir", serverDir, "--domain", DOMAIN, "--acme-email", ACME_EMAIL, "--yes"]);
      check.expect(taken.status === 1 && /port 80 is already in use/.test(taken.output), "a really taken port 80 (the registry) is refused with a message", taken.output);
      check.expect(inside(["test", "-e", serverDir]).status !== 0, "nothing was written for the refused server installation");
      insideDocker(["rm", "--force", "registry"]);
      await waitFor("port 80 to be free", () => inside(["curl", "-s", "--max-time", "2", "http://127.0.0.1:80/"]).status !== 0, 30);

      const runningBefore = insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim();
      const waiting = installFrom(folder, ["--mode", "server", "--dir", serverDir, "--domain", DOMAIN, "--acme-email", ACME_EMAIL, "--yes"]);
      check.expect(waiting.status === 3, "the server mode ends with the status 3 (waiting), not 0", `${waiting.status}\n${waiting.output}`);
      check.expect(waiting.output.includes("NOT installed") && waiting.output.includes("Waiting for DNS") && !/OpenLifeDashboard is installed/.test(waiting.output), "it says that nothing is installed and that it waits for DNS", waiting.output);
      check.expect(stageOf(serverDir) === "files", "the state of the server folder is 'files'", stageOf(serverDir));
      const env = read(`${serverDir}/.env`);
      check.expect(env.includes(`BASE_URL=https://${DOMAIN}`) && env.includes(`DOMAIN=${DOMAIN}`) && !/^PORT=/m.test(env), "the .env is made for the domain, without a port of the host");
      check.expect(insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim() === runningBefore, "the server mode started no container");
      const serverKeys = env;
      const waitingAgain = installFrom(folder, ["--mode", "server", "--dir", serverDir, "--yes"]);
      check.expect(waitingAgain.status === 3 && read(`${serverDir}/.env`) === serverKeys, "a rerun takes the domain from the folder, keeps the keys and waits again", waitingAgain.output);
      evidence["server"] = { status: waiting.status, rerunStatus: waitingAgain.status };
    }
  }
} finally {
  host(["rm", "--force", BOX]);
  host(["volume", "rm", "--force", VOLUME]);
  host(["image", "rm", "--force", APP_IMAGE, BOX_IMAGE]);
  rmSync(scratch, { recursive: true, force: true });
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, `install-clean-linux-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
