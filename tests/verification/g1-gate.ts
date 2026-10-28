// Gate G1 (DEV §8.4, D20.3): joins the verify:task reports of the tasks of the vertical path
// (tests/verification/g1-matrix.ts) that refer to exactly the code being checked and decides every
// item of G1 from the logs of the checks that ran it. A missing report or line is blocked, a failed
// check or test fails, none is dropped from the result; what G1 does not prove is named.
// Reports come from OPENLIFE_G1_REPORTS_DIR (default .artifacts; CI downloads them there).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE, EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G1_ITEMS, G1_REPORTS, NOT_RUN } from "./g1-matrix.ts";
import { judgeEvidence, latestReports, loadReports, worst, type Verdict } from "./report-join.ts";

const reportsDir = path.resolve(repoRoot, process.env["OPENLIFE_G1_REPORTS_DIR"] ?? ".artifacts");
const code = describeCode(repoRoot);
const reports = latestReports(loadReports(reportsDir), G1_REPORTS, code);

console.log(`G1 for ${String(code["commit"]).slice(0, 7)}${code["dirty"] ? " with uncommitted changes" : ""}, reports from ${path.relative(repoRoot, reportsDir) || reportsDir}`);
const reportResults = G1_REPORTS.map((task) => {
  const source = reports.get(task);
  const verdict: Verdict = !source ? "blocked" : source.report["result"] === "passed" ? "passed" : "failed";
  console.log(`  ${verdict.padEnd(7)} report ${task}${source ? ` (${String(source.report["runId"])}, ${String(source.report["result"])})` : " — none for this code"}`);
  return { task, verdict, runId: source?.report["runId"] ?? null, environment: source?.report["environment"] ?? null };
});
const itemResults = G1_ITEMS.map((item) => {
  const judged = item.evidence.map((evidence) => ({ ...evidence, ...judgeEvidence(reports, evidence) }));
  // An item with no evidence named is a missing mandatory test, not a pass.
  const verdict: Verdict = judged.length === 0 ? "failed" : worst(judged.map((entry) => entry.verdict));
  console.log(`  ${verdict.padEnd(7)} ${item.group}: ${item.id} — ${item.title}`);
  for (const entry of judged.filter((each) => each.verdict !== "passed")) console.log(`            ${entry.verdict}: ${entry.detail} — "${entry.line}"`);
  return { id: item.id, group: item.group, title: item.title, verdict, evidence: judged };
});
const result = worst([...reportResults, ...itemResults].map((entry) => entry.verdict));
console.log(`  not run: ${NOT_RUN.map((entry) => `${entry.item} (${entry.task})`).join("; ")}`);
console.log(`G1 ${result}: ${itemResults.filter((entry) => entry.verdict === "passed").length} of ${itemResults.length} items passed`);

const evidenceDir = process.env[EVIDENCE_DIR_ENV];
if (evidenceDir) writeFileSync(path.join(evidenceDir, "g1-gate.json"), `${JSON.stringify({ code, reportsDir, result, reports: reportResults, items: itemResults, notRun: NOT_RUN }, null, 2)}\n`);
process.exitCode = result === "passed" ? 0 : result === "blocked" ? BLOCKED_EXIT_CODE : 1;
