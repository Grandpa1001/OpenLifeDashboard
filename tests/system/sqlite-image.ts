// D02.2 — the app image built natively for this host's architecture (no emulation) runs the
// real better-sqlite3 driver as a non-root user. AC1: file, INSERT/SELECT and rollback counts;
// AC2: a forced probe failure and a missing native module both exit nonzero.
// Both architectures are covered by running this check on linux/amd64 and linux/arm64 hosts
// (CI matrix); OPENLIFE_EXPECT_ARCH makes a misassigned runner fail instead of re-testing one arch.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { blockCheck, createCheck } from "../support/check-report.ts";
import { docker, hostDockerArch, nodeArchFor } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-d02";
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE = ["--entrypoint", "node", IMAGE, "apps/server/dist/cli/sqlite-probe.js"] as const;
// Exit code the shell uses when the native module was not even found to remove.
const NOTHING_TO_REMOVE = 90;
const REMOVE_NATIVE_MODULE = [
  'modules=$(find /app -path "*/better-sqlite3/prebuilds/linux-*.node")',
  `[ -n "$modules" ] || exit ${NOTHING_TO_REMOVE}`,
  "rm $modules",
  "exec node apps/server/dist/cli/sqlite-probe.js",
].join("; ");

const lastJsonLine = (output: string): JsonObject | undefined =>
  output
    .trim()
    .split("\n")
    .reverse()
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isJsonObject(value) ? value : undefined;
      } catch {
        return undefined;
      }
    })
    .find(Boolean);

const host = hostDockerArch();
if (!host) {
  blockCheck(`host architecture ${process.arch} has no supported linux image`);
}
const serverArch = docker(["version", "--format", "{{.Server.Arch}}"], repoRoot);
if (serverArch.status !== 0) {
  blockCheck(`the docker daemon is not reachable:\n${serverArch.output.trim()}`);
}
if (serverArch.output.trim() !== host) {
  blockCheck(`docker runs ${serverArch.output.trim()} containers on a ${host} host; emulation is not accepted`);
}
const expected = process.env["OPENLIFE_EXPECT_ARCH"];
const platform = `linux/${host}`;
const evidence: Record<string, unknown> = { hostArch: host, platform };

const check = createCheck(`app image on ${platform} (native)`);
if (expected) {
  check.expect(expected === host, `runner architecture is the expected ${expected} (got ${host})`);
}
try {
  const build = docker(["build", "--platform", platform, "-f", "docker/Dockerfile", "-t", IMAGE, "."], repoRoot, BUILD_TIMEOUT_MS);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const inspect = docker(["image", "inspect", IMAGE, "--format", "{{json .}}"], repoRoot);
    const image = lastJsonLine(inspect.output) ?? {};
    const config = isJsonObject(image["Config"]) ? image["Config"] : {};
    evidence["image"] = { id: image["Id"], os: image["Os"], architecture: image["Architecture"], user: config["User"] };
    check.expect(image["Os"] === "linux" && image["Architecture"] === host, `image is linux/${String(image["Architecture"])}`);
    check.expect(config["User"] === "node", `image runs as the non-root user "node" (got ${JSON.stringify(config["User"])})`);
    const uid = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"], repoRoot);
    check.expect(uid.status === 0 && uid.output.trim() !== "0", `container uid is not 0 (got ${uid.output.trim()})`);

    // D02.2-AC1
    const probe = docker(["run", "--rm", "--platform", platform, ...PROBE], repoRoot);
    const result = lastJsonLine(probe.output);
    evidence["probe"] = result ?? probe.output;
    check.expect(probe.status === 0 && result?.["ok"] === true, "AC1: driver probe exits 0 with ok=true", probe.output);
    check.expect(
      result?.["arch"] === nodeArchFor(host) && result["platform"] === "linux",
      `AC1: probe executed on linux/${String(result?.["arch"])} (${String(result?.["machine"])})`,
    );
    check.expect(
      result?.["rowsAfterCommit"] === 3 && result["rowsAfterRollback"] === 3 && result["rowsAfterReopen"] === 3,
      "AC1: 3 committed rows survive a rolled-back batch and a reopen of the file",
      JSON.stringify(result),
    );

    // D02.2-AC2
    const unwritable = docker(["run", "--rm", ...PROBE, "--dir", "/app"], repoRoot);
    evidence["forcedFailure"] = { exitCode: unwritable.status, output: lastJsonLine(unwritable.output) ?? unwritable.output };
    check.expect(unwritable.status === 1, `AC2: probe in a read-only directory exits 1 (got ${unwritable.status})`, unwritable.output);
    const missing = docker(["run", "--rm", "--user", "root", "--entrypoint", "sh", IMAGE, "-c", REMOVE_NATIVE_MODULE], repoRoot);
    evidence["missingNativeModule"] = { exitCode: missing.status, output: lastJsonLine(missing.output) ?? missing.output };
    check.expect(missing.status !== NOTHING_TO_REMOVE, "AC2: the image contains the linux native module", missing.output);
    check.expect(
      missing.status === 1 && lastJsonLine(missing.output)?.["ok"] === false,
      `AC2: without the native module the probe fails (exit ${missing.status}) instead of being skipped`,
      missing.output,
    );
  }
} finally {
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    writeFileSync(path.join(evidenceDir, `image-${host}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
}
check.finish();
