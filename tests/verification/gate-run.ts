// The run of a gate of a stage (DEV §8.4): joins the verify:task reports of its tasks that refer to
// exactly the code being checked and decides every item from the logs of the checks that ran it. A
// missing report or line is blocked, a failed check or test fails, none is dropped from the result;
// what the gate does not prove is named. Gates G1 and G2 differ only in their matrix.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE, EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { judgeEvidence, latestReports, loadReports, worst, type Evidence, type Verdict } from "./report-join.ts";

export type GateItem = Readonly<{ id: string; group: string; title: string; evidence: readonly Evidence[] }>;
export type GateMatrix = Readonly<{
  /** The name of the gate, e.g. G1, as its output and its evidence file say it. */
  gate: string;
  reports: readonly string[];
  items: readonly GateItem[];
  notRun: ReadonlyArray<Readonly<{ item: string; task: string }>>;
  /** The variable that names the folder of the reports (default .artifacts; CI downloads them there). */
  reportsDirEnv: string;
}>;

export function runGate(matrix: GateMatrix): void {
  const reportsDir = path.resolve(repoRoot, process.env[matrix.reportsDirEnv] ?? ".artifacts");
  const code = describeCode(repoRoot);
  const reports = latestReports(loadReports(reportsDir), matrix.reports, code);

  console.log(`${matrix.gate} for ${String(code["commit"]).slice(0, 7)}${code["dirty"] ? " with uncommitted changes" : ""}, reports from ${path.relative(repoRoot, reportsDir) || reportsDir}`);
  const reportResults = matrix.reports.map((task) => {
    const source = reports.get(task);
    const verdict: Verdict = !source ? "blocked" : source.report["result"] === "passed" ? "passed" : "failed";
    console.log(`  ${verdict.padEnd(7)} report ${task}${source ? ` (${String(source.report["runId"])}, ${String(source.report["result"])})` : " — none for this code"}`);
    return { task, verdict, runId: source?.report["runId"] ?? null, environment: source?.report["environment"] ?? null };
  });
  const itemResults = matrix.items.map((item) => {
    const judged = item.evidence.map((evidence) => ({ ...evidence, ...judgeEvidence(reports, evidence) }));
    // An item with no evidence named is a missing mandatory test, not a pass.
    const verdict: Verdict = judged.length === 0 ? "failed" : worst(judged.map((entry) => entry.verdict));
    console.log(`  ${verdict.padEnd(7)} ${item.group}: ${item.id} — ${item.title}`);
    for (const entry of judged.filter((each) => each.verdict !== "passed")) console.log(`            ${entry.verdict}: ${entry.detail} — "${entry.line}"`);
    return { id: item.id, group: item.group, title: item.title, verdict, evidence: judged };
  });
  const result = worst([...reportResults, ...itemResults].map((entry) => entry.verdict));
  console.log(`  not run: ${matrix.notRun.map((entry) => `${entry.item} (${entry.task})`).join("; ")}`);
  console.log(`${matrix.gate} ${result}: ${itemResults.filter((entry) => entry.verdict === "passed").length} of ${itemResults.length} items passed`);

  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) writeFileSync(path.join(evidenceDir, `${matrix.gate.toLowerCase()}-gate.json`), `${JSON.stringify({ code, reportsDir, result, reports: reportResults, items: itemResults, notRun: matrix.notRun }, null, 2)}\n`);
  process.exitCode = result === "passed" ? 0 : result === "blocked" ? BLOCKED_EXIT_CODE : 1;
}
