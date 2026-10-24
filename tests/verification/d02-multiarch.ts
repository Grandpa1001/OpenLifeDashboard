// D02.3-AC3: `verify:task -- D02` joins real reports of both architectures. Checks the joining
// rules on synthetic reports (complete, missing arch, failed, stale commit, dirty tree, build
// without execution) and that the task map and CI are wired to run them for D02.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verificationTasks } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import type { DockerArch } from "../support/docker.ts";
import { evaluateArchReports, type ArchVerdict } from "../support/multiarch-reports.ts";
import { repoRoot } from "../support/repository-copy.ts";

const COMMIT = "c0ffee0000000000000000000000000000000000";
const NODE_ARCH: Readonly<Record<DockerArch, string>> = { amd64: "x64", arm64: "arm64" };

type ReportOptions = Partial<{ result: string; commit: string; dirty: boolean; withEvidence: boolean }>;

function writeReport(dir: string, arch: DockerArch, task: string, options: ReportOptions = {}): void {
  const runDir = path.join(dir, arch, `${task}-${arch}`);
  mkdirSync(path.join(runDir, "evidence", "check"), { recursive: true });
  const evidenceName = task === "D02.2" ? `image-${arch}.json` : `container-${arch}.json`;
  const evidence =
    task === "D02.2"
      ? { probe: { platform: "linux", arch: NODE_ARCH[arch], rowsAfterCommit: 3, rowsAfterRollback: 3, rowsAfterReopen: 3 } }
      : { responses: [{}, {}, {}, {}], healthcheck: "healthy", stop: { exitCode: 0 } };
  const withEvidence = options.withEvidence ?? true;
  if (withEvidence) {
    writeFileSync(path.join(runDir, "evidence", "check", evidenceName), JSON.stringify(evidence));
  }
  const report = {
    task,
    result: options.result ?? "passed",
    finishedAt: "2026-10-24T20:00:00.000Z",
    code: { git: true, commit: options.commit ?? COMMIT, dirty: options.dirty ?? false },
    environment: { platform: "linux", arch: NODE_ARCH[arch] },
    checks: [{ id: "check", evidence: withEvidence ? [`evidence/check/${evidenceName}`] : [] }],
  };
  writeFileSync(path.join(runDir, "verification.json"), JSON.stringify(report));
}

function scenario(prepare: (dir: string) => void): ArchVerdict[] {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openlife-multiarch-")));
  try {
    prepare(dir);
    return evaluateArchReports(dir, COMMIT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const complete = (dir: string, arches: readonly DockerArch[] = ["amd64", "arm64"]): void => {
  for (const arch of arches) {
    writeReport(dir, arch, "D02.2");
    writeReport(dir, arch, "D02.3");
  }
};
const verdictOf = (verdicts: ArchVerdict[], arch: DockerArch): string | undefined =>
  verdicts.find((v) => v.arch === arch)?.verdict;

const check = createCheck("D02 multi-architecture join");
const all = scenario((dir) => complete(dir));
check.expect(all.every((v) => v.verdict === "passed"), "both architectures with execution evidence → passed", JSON.stringify(all));
const onlyAmd = scenario((dir) => complete(dir, ["amd64"]));
check.expect(verdictOf(onlyAmd, "arm64") === "blocked" && verdictOf(onlyAmd, "amd64") === "passed", "missing linux/arm64 reports → arm64 blocked");
const failedArm = scenario((dir) => {
  complete(dir);
  writeReport(dir, "arm64", "D02.3", { result: "failed" });
});
check.expect(verdictOf(failedArm, "arm64") === "failed", "a failed arm64 report → failed");
const stale = scenario((dir) => {
  complete(dir);
  writeReport(dir, "amd64", "D02.2", { commit: "0".repeat(40) });
});
check.expect(verdictOf(stale, "amd64") === "failed", "a report for another commit → failed");
const dirty = scenario((dir) => {
  complete(dir);
  writeReport(dir, "amd64", "D02.3", { dirty: true });
});
check.expect(verdictOf(dirty, "amd64") === "failed", "a report from a dirty working tree → failed");
const buildOnly = scenario((dir) => {
  complete(dir);
  writeReport(dir, "arm64", "D02.2", { withEvidence: false });
});
check.expect(verdictOf(buildOnly, "arm64") === "failed", "a passed report without execution evidence (build only) → failed");
const none = scenario(() => undefined);
check.expect(none.every((v) => v.verdict === "blocked"), "no reports at all → blocked, never passed");

const d02 = verificationTasks.find((task) => task.id === "D02");
check.expect(
  d02?.ready === true &&
    JSON.stringify(d02.steps) === JSON.stringify(["D02.1", "D02.2", "D02.3"]) &&
    d02.checks.some((c) => c.command.join(" ") === "node tests/system/multiarch-reports.ts"),
  "verify:task D02 runs D02.1–D02.3 and the multi-architecture join",
);
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8").split("\n").map((line) => line.trim());
check.expect(
  workflow.includes("run: pnpm verify:task -- D02.2") && workflow.includes("run: pnpm verify:task -- D02.3"),
  "CI runs D02.2 and D02.3 on each architecture",
);
check.expect(
  workflow.includes("pattern: verification-image-*") && workflow.includes("run: pnpm verify:task -- D02"),
  "CI downloads both architecture reports and runs verify:task -- D02",
);
check.finish();
