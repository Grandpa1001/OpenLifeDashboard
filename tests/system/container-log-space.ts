// D06.2-AC2 — the log file runs out of space on a real, size-limited file system, inside the app
// image on this host's native architecture. The log folder is a 2 MiB tmpfs; the script
// (tests/system/in-container/log-space.mjs) writes through the real rotating sink until the file
// system is full. Every line must be either whole in the file or counted as lost, the sink must be
// degraded with one stderr notice, stdout (the other sink) must have every line, and writing must
// resume once space is freed and the reopen interval has passed.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { buildAppImage, docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-d06-log-space";
const SCRIPT = path.join(repoRoot, "tests/system/in-container/log-space.mjs");
const AFTER_FULL_LINES = 50;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`log file out of space on a limited file system in the container on ${platform}`);
let observations: JsonObject | undefined;

const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const text = (value: unknown): string => JSON.stringify(value);

try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const run = docker(
      [
        "run", "--rm", "--platform", platform,
        "--tmpfs", "/logs-small:size=2m,mode=1777",
        "--volume", `${SCRIPT}:/script/log-space.mjs:ro`,
        "--entrypoint", "node", IMAGE, "/script/log-space.mjs",
      ],
      repoRoot,
      5 * 60 * 1000,
    );
    const uid = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"], repoRoot).output.trim();
    check.expect(uid !== "" && uid !== "0", `the script runs as non-root uid ${uid}`);
    check.expect(run.status === 0, `the script exits 0 (got ${run.status})`, run.output);
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.output.trim().split("\n").at(-1) ?? "");
    } catch {
      parsed = undefined;
    }
    if (check.expect(isJsonObject(parsed), "the script prints its observations as JSON", run.output)) {
      observations = object(parsed);
      const { produced, degradedAt, stdoutLines, fileLines, wholeLines, wholeAfter, fileLinesAfterRecovery } = observations;
      const afterFull = object(observations["afterFull"]);
      const afterMore = object(observations["afterMore"]);
      const recovered = object(observations["recovered"]);
      const notices = Array.isArray(observations["notices"]) ? observations["notices"] : [];
      check.expect(afterFull["degraded"] === true && typeof afterFull["lostLines"] === "number" && afterFull["lostLines"] > 0, "the full file system makes the sink degraded and counts lost lines", text(afterFull));
      check.expect(
        typeof fileLines === "number" && typeof afterFull["lostLines"] === "number" && fileLines + afterFull["lostLines"] === degradedAt,
        "every line written until the failure is either in the file or counted as lost",
        text({ fileLines, lost: afterFull["lostLines"], degradedAt }),
      );
      check.expect(wholeLines === true, "the file holds only whole JSON lines: a write that stopped half-way was cut back");
      check.expect(afterMore["lostLines"] === (afterFull["lostLines"] as number) + AFTER_FULL_LINES && afterMore["queuedBytes"] === 0, "later lines are counted as lost and nothing stays queued", text(afterMore));
      check.expect(stdoutLines === produced, "stdout, the other sink, received every line", text({ stdoutLines, produced }));
      check.expect(notices.length === 1 && text(notices[0]).includes('"LOG_SINK_UNAVAILABLE"') && !text(notices[0]).includes("/"), "one stderr notice without a path", text(notices));
      check.expect(recovered["degraded"] === false && fileLinesAfterRecovery === (fileLines as number) + 1 && wholeAfter === true, "after space is freed and the reopen interval passed, writing resumes with whole lines", text({ recovered, fileLinesAfterRecovery }));
    }
  }
} finally {
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir && observations) {
    writeFileSync(path.join(evidenceDir, `container-log-space-${arch}.json`), `${JSON.stringify(observations, null, 2)}\n`);
  }
}
check.finish();
