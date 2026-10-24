// D02 — joins the D02.2/D02.3 reports of both architectures for the current commit.
// Reports come from CI (downloaded into OPENLIFE_ARCH_REPORTS_DIR, default
// .artifacts/arch-reports). A missing architecture is blocked; a failed, stale or
// evidence-free report fails.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { blockCheck, createCheck } from "../support/check-report.ts";
import { evaluateArchReports } from "../support/multiarch-reports.ts";
import { repoRoot } from "../support/repository-copy.ts";

const reportsDir = path.resolve(repoRoot, process.env["OPENLIFE_ARCH_REPORTS_DIR"] ?? ".artifacts/arch-reports");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
if (head.status !== 0) {
  blockCheck("a git checkout is required to know which commit the reports must match");
}
const commit = head.stdout.trim();
const verdicts = evaluateArchReports(reportsDir, commit);

const evidenceDir = process.env[EVIDENCE_DIR_ENV];
if (evidenceDir) {
  writeFileSync(path.join(evidenceDir, "multiarch.json"), `${JSON.stringify({ commit, reportsDir, verdicts }, null, 2)}\n`);
}
if (verdicts.every((v) => v.verdict !== "failed") && verdicts.some((v) => v.verdict === "blocked")) {
  for (const v of verdicts) {
    console.log(`  linux/${v.arch}: ${v.verdict}${v.reasons.length > 0 ? ` — ${v.reasons.join("; ")}` : ""}`);
  }
  blockCheck(`reports for both architectures are required in ${path.relative(repoRoot, reportsDir) || reportsDir}`);
}
const check = createCheck(`D02 reports of both architectures for ${commit.slice(0, 7)}`);
for (const v of verdicts) {
  check.expect(v.verdict === "passed", `linux/${v.arch}: ${v.verdict} (${v.reports.join(", ")})`, v.reasons.join("\n"));
}
check.finish();
