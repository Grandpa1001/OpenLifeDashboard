// Gate G0 (DEV §8.4, D08.3): joins the verify:task reports of KM0 (D01, D02.1, D03–D08) that refer to exactly the code
// being checked (commit and uncommitted state) and decides every item of G0 and every case of the
// failure matrix (tests/verification/g0-matrix.ts) from the logs of the checks that ran it.
// Reports come from OPENLIFE_G0_REPORTS_DIR (default .artifacts; CI downloads them there).
// A missing report or case is blocked, a failed or absent assertion fails; none is dropped from
// the result. The images of both architectures are joined by the D02 step of G0.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE, EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G0_CASES, G0_REPORTS, type CaseEvidence } from "./g0-matrix.ts";
import { judgeEvidence, latestReports, loadReports, worst, type Verdict } from "./report-join.ts";

const reportsDir = path.resolve(repoRoot, process.env["OPENLIFE_G0_REPORTS_DIR"] ?? ".artifacts");
const code = describeCode(repoRoot);
const reports = latestReports(loadReports(reportsDir), G0_REPORTS, code);
const judge = (evidence: CaseEvidence): ReturnType<typeof judgeEvidence> => judgeEvidence(reports, evidence);

console.log(`G0 for ${String(code["commit"]).slice(0, 7)}${code["dirty"] ? " with uncommitted changes" : ""}, reports from ${path.relative(repoRoot, reportsDir) || reportsDir}`);
const reportResults = G0_REPORTS.map((task) => {
  const source = reports.get(task);
  const verdict: Verdict = !source ? "blocked" : source.report["result"] === "passed" ? "passed" : "failed";
  console.log(`  ${verdict.padEnd(7)} report ${task}${source ? ` (${String(source.report["runId"])}, ${String(source.report["result"])})` : " — none for this code"}`);
  return { task, verdict, runId: source?.report["runId"] ?? null, environment: source?.report["environment"] ?? null };
});
const caseResults = G0_CASES.map((item) => {
  const judged = item.evidence.map((evidence) => ({ ...evidence, ...judge(evidence) }));
  const verdict = worst(judged.map((entry) => entry.verdict));
  console.log(`  ${verdict.padEnd(7)} ${item.group}: ${item.title}`);
  for (const entry of judged.filter((each) => each.verdict !== "passed")) console.log(`            ${entry.verdict}: ${entry.detail} — "${entry.line}"`);
  return { id: item.id, group: item.group, title: item.title, verdict, evidence: judged };
});
const result = worst([...reportResults, ...caseResults].map((entry) => entry.verdict));
console.log(`G0 ${result}: ${caseResults.filter((entry) => entry.verdict === "passed").length} of ${caseResults.length} cases passed`);

const evidenceDir = process.env[EVIDENCE_DIR_ENV];
if (evidenceDir) writeFileSync(path.join(evidenceDir, "g0-gate.json"), `${JSON.stringify({ code, reportsDir, result, reports: reportResults, cases: caseResults }, null, 2)}\n`);
process.exitCode = result === "passed" ? 0 : result === "blocked" ? BLOCKED_EXIT_CODE : 1;
