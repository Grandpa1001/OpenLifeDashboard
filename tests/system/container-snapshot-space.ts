// D05.3-AC2 — a snapshot that runs out of space on a real, size-limited file system, inside the
// app image on this host's native architecture. The backup folder is a 16 MiB tmpfs; the script
// (tests/system/in-container/snapshot-space.mjs) leaves exactly one database copy of space free,
// so the free-space check passes and the write itself fails with ENOSPC. The upgrade must stop
// with MIGRATION_SNAPSHOT_REQUIRED, publish nothing, clean its staging and leave the database,
// the gate and the last good snapshot untouched; after space is freed it succeeds.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { buildAppImage, docker, requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const IMAGE = "openlife-app:verify-d05-space";
const SCRIPT = path.join(repoRoot, "tests/system/in-container/snapshot-space.mjs");
const BLOCK_SLACK_BYTES = 8192;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`snapshot out of space on a limited file system in the container on ${platform}`);
let observations: JsonObject | undefined;

const object = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
const text = (value: unknown): string => JSON.stringify(value);

try {
  const build = buildAppImage(IMAGE, platform, repoRoot);
  if (check.expect(build.status === 0, `docker build --platform ${platform} exits 0`, build.output)) {
    const run = docker(
      [
        "run", "--rm", "--platform", platform,
        // Roomy data and gate; the backup folder is the limited file system under test.
        "--tmpfs", "/data:size=64m,mode=1777",
        "--tmpfs", "/backup-small:size=16m,mode=1777",
        "--volume", `${SCRIPT}:/script/snapshot-space.mjs:ro`,
        "--entrypoint", "node", IMAGE, "/script/snapshot-space.mjs",
      ],
      repoRoot,
      5 * 60 * 1000,
    );
    const uid = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"], repoRoot).output.trim();
    check.expect(uid !== "" && uid !== "0", `the script runs as non-root uid ${uid}`);
    check.expect(run.status === 0, `the script exits 0 (got ${run.status})`, run.output);
    const line = run.output.trim().split("\n").at(-1) ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (check.expect(isJsonObject(parsed), "the script prints its observations as JSON", run.output)) {
      observations = object(parsed);
      const { databaseBytes, freeAfterFill, probeCode } = observations;
      const direct = object(observations["direct"]);
      const refusal = object(observations["afterRefusal"]);
      check.expect(probeCode === "ENOSPC", "the backup file system is really limited: writing past it fails with ENOSPC", text(probeCode));
      check.expect(
        typeof databaseBytes === "number" && typeof freeAfterFill === "number" && freeAfterFill >= databaseBytes && freeAfterFill - databaseBytes < BLOCK_SLACK_BYTES,
        "exactly one database copy of space is free: the free-space check passes",
        text({ databaseBytes, freeAfterFill }),
      );
      check.expect(text(direct["result"]) === '{"ok":false,"code":"SNAPSHOT_FAILED"}', "the write runs out of space: SNAPSHOT_FAILED, not SNAPSHOT_LOW_SPACE", text(direct));
      check.expect(text(direct["staging"]) === "[]" && direct["freeBytes"] === freeAfterFill, "the failed snapshot cleans its staging and gives its space back", text(direct));
      check.expect(
        text(refusal["result"]) === '{"ok":false,"code":"MIGRATION_SNAPSHOT_REQUIRED","fields":["schemaVersion"]}',
        "the upgrade stops with MIGRATION_SNAPSHOT_REQUIRED",
        text(refusal),
      );
      check.expect(Array.isArray(refusal["published"]) && refusal["published"].length === 1, "no new package was published", text(refusal["published"]));
      check.expect(refusal["goodUntouched"] === true, "the last good snapshot is byte for byte unchanged and verifies");
      check.expect(text(refusal["staging"]) === "[]" && refusal["freeBytes"] === freeAfterFill, "staging is clean and the space is free again");
      check.expect(refusal["gateActiveOperation"] === null, "the refused operation is closed in the gate");
      check.expect(text(refusal["inspection"]) === '{"kind":"current","schemaVersion":1}', "the database is still at its version", text(refusal["inspection"]));
      check.expect(text(observations["retry"]) === '{"ok":true,"schemaVersion":2}', "after space is freed the same upgrade succeeds", text(observations["retry"]));
      check.expect(observations["publishedAfterRetry"] === 2 && observations["goodStillVerifies"] === true, "the retry published a second package next to the good one");
    }
  }
} finally {
  docker(["image", "rm", "--force", IMAGE], repoRoot);
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir && observations) {
    writeFileSync(path.join(evidenceDir, `container-snapshot-space-${arch}.json`), `${JSON.stringify(observations, null, 2)}\n`);
  }
}
check.finish();
