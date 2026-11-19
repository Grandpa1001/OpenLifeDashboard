// D58.4 — the release package on a clean Linux (DEV §9.57). A container of Ubuntu 24.04 with its own Docker daemon
// (the packages of the distribution, a user that is not root) receives the app image through a registry that runs in
// it, and the release package, made for the digest of that image, is unpacked and run there as a user would run it:
//   AC1: the local mode installs, the owner signs in, a second run changes nothing, and the folder is not a different
//        installation when the run is repeated with a newer package next to it;
//   AC2: the server mode with a domain that does not resolve ends with the state of waiting (status 3, NOT installed),
//        starts nothing, keeps its keys on a rerun, and a really taken port 80 is refused before anything is written.
// The password is on stdin only. The server mode that goes through every stage with HTTPS is tests/system/install-server-linux.ts (D60.4).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { HOME, withCleanLinux } from "../support/clean-linux.ts";
import { requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const OWNER_EMAIL = "wlasciciel@example.com";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const PORT = 18080;
const DOMAIN = "dziennik.example.invalid";
const ACME_EMAIL = "admin@example.com";
const TEN_MINUTES_S = 10 * 60;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`install.sh from a release package on a clean Linux (${platform})`);
const evidence: Record<string, unknown> = {};

await withCleanLinux(check, { name: "d58" }, async ({ facts, inside, insideDocker, read, stageOf, installFrom, waitFor }) => {
  evidence["linux"] = facts;
  // ---- AC1: the local mode from the package.
  const dir = `${HOME}/Moja instalacja`;
  const startedAt = Date.now();
  const first = installFrom(["--dir", dir, "--port", String(PORT), "--owner-email", OWNER_EMAIL, "--owner-password-stdin", "--yes"], `${PASSWORD}\n`);
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
    const again = installFrom(["--dir", dir, "--yes"]);
    check.expect(again.status === 0 && again.output.includes("nothing was changed"), "a second run of a complete installation only shows its status", again.output);
    check.expect(identity() === before && insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim() === containerBefore, "the second run keeps the keys, the files and the very same container");
    check.expect(signIn(PASSWORD) === "200", "the owner still signs in after the second run");
    evidence["local"] = { seconds, status: first.status, rerunStatus: again.status };
  }

  // ---- AC2: the server mode for a domain that does not resolve, on a real Linux.
  const serverDir = `${HOME}/serwer dane`;
  const taken = installFrom(["--mode", "server", "--dir", serverDir, "--domain", DOMAIN, "--acme-email", ACME_EMAIL, "--yes"]);
  check.expect(taken.status === 1 && /port 80 is already in use/.test(taken.output), "a really taken port 80 (the registry) is refused with a message", taken.output);
  check.expect(inside(["test", "-e", serverDir]).status !== 0, "nothing was written for the refused server installation");
  insideDocker(["rm", "--force", "registry"]);
  await waitFor("port 80 to be free", () => inside(["curl", "-s", "--max-time", "2", "http://127.0.0.1:80/"]).status !== 0, 30);

  const runningBefore = insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim();
  const waiting = installFrom(["--mode", "server", "--dir", serverDir, "--domain", DOMAIN, "--acme-email", ACME_EMAIL, "--yes"]);
  check.expect(waiting.status === 3, "the server mode ends with the status 3 (waiting), not 0", `${waiting.status}\n${waiting.output}`);
  check.expect(waiting.output.includes("NOT installed") && waiting.output.includes("Waiting for DNS") && !/OpenLifeDashboard is installed/.test(waiting.output), "it says that nothing is installed and that it waits for DNS", waiting.output);
  check.expect(stageOf(serverDir) === "files", "the state of the server folder is 'files'", stageOf(serverDir));
  const env = read(`${serverDir}/.env`);
  check.expect(env.includes(`BASE_URL=https://${DOMAIN}`) && env.includes(`DOMAIN=${DOMAIN}`) && !/^PORT=/m.test(env), "the .env is made for the domain, without a port of the host");
  check.expect(insideDocker(["ps", "--quiet", "--no-trunc"]).stdout.trim() === runningBefore, "the server mode started no container");
  const serverKeys = env;
  const waitingAgain = installFrom(["--mode", "server", "--dir", serverDir, "--yes"]);
  check.expect(waitingAgain.status === 3 && read(`${serverDir}/.env`) === serverKeys, "a rerun takes the domain from the folder, keeps the keys and waits again", waitingAgain.output);
  evidence["server"] = { status: waiting.status, rerunStatus: waitingAgain.status };
});
const evidenceDir = process.env[EVIDENCE_DIR_ENV];
if (evidenceDir) {
  writeFileSync(path.join(evidenceDir, `install-clean-linux-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
check.finish();
