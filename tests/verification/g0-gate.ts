// Gate G0 (DEV §8.4, D08.3): joins the verify:task reports of KM0 (D01, D02.1, D03–D08) that refer to exactly the code
// being checked (commit and uncommitted state) and decides every item of G0 and every case of the
// failure matrix (tests/verification/g0-matrix.ts) from the logs of the checks that ran it.
// Reports come from OPENLIFE_G0_REPORTS_DIR (default .artifacts; CI downloads them there).
// A missing report or case is blocked, a failed or absent assertion fails; none is dropped from
// the result. The images of both architectures are joined by the D02 step of G0.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { BLOCKED_EXIT_CODE, EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G0_CASES, G0_REPORTS, type CaseEvidence, type G0Report } from "./g0-matrix.ts";

type Verdict = "passed" | "failed" | "blocked";
type Loaded = Readonly<{ file: string; report: JsonObject }>;

const reportsDir = path.resolve(repoRoot, process.env["OPENLIFE_G0_REPORTS_DIR"] ?? ".artifacts");
const code = describeCode(repoRoot);
const sameCode = (value: unknown): boolean => JSON.stringify(value) === JSON.stringify(code);
/** A passed vitest/Playwright test (✓) or an "ok" assertion of a system script. */
const PASSED_LINE = /✓|^\s*ok\s/;

function loadReports(): Loaded[] {
  let entries: string[];
  try {
    entries = readdirSync(reportsDir, { recursive: true }).map(String);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => path.basename(entry) === "verification.json")
    .flatMap((entry) => {
      const file = path.join(reportsDir, entry);
      try {
        const report: unknown = JSON.parse(readFileSync(file, "utf8"));
        return isJsonObject(report) ? [{ file, report }] : [];
      } catch {
        return [];
      }
    });
}

const loaded = loadReports();
const reports = new Map<G0Report, Loaded>();
for (const task of G0_REPORTS) {
  const latest = loaded
    .filter(({ report }) => report["task"] === task && sameCode(report["code"]))
    .sort((a, b) => String(a.report["finishedAt"]).localeCompare(String(b.report["finishedAt"])))
    .at(-1);
  if (latest) reports.set(task, latest);
}

function judge(evidence: CaseEvidence): Readonly<{ verdict: Verdict; detail: string }> {
  const source = reports.get(evidence.task);
  if (!source) return { verdict: "blocked", detail: `no ${evidence.task} report for this code` };
  const checks = Array.isArray(source.report["checks"]) ? source.report["checks"].filter(isJsonObject) : [];
  const run = checks.find((item) => item["id"] === evidence.check);
  if (!run) return { verdict: "failed", detail: `${evidence.task} report has no check ${evidence.check}` };
  if (run["status"] === "blocked" || run["status"] === "not_run") return { verdict: "blocked", detail: `${evidence.check} is ${String(run["status"])}` };
  let log: string;
  try {
    log = readFileSync(path.join(path.dirname(source.file), String(run["log"])), "utf8");
  } catch {
    return { verdict: "failed", detail: `${evidence.check} has no log` };
  }
  const lines = log.split("\n").filter((line) => line.includes(evidence.line));
  if (run["status"] === "passed" && lines.some((line) => PASSED_LINE.test(line))) return { verdict: "passed", detail: `${evidence.task}/${evidence.check}` };
  return { verdict: "failed", detail: `${evidence.task}/${evidence.check} is ${String(run["status"])}; ${lines.length === 0 ? "the line is not in its log" : lines[0]?.trim()}` };
}

const worst = (verdicts: readonly Verdict[]): Verdict => (verdicts.includes("failed") ? "failed" : verdicts.includes("blocked") ? "blocked" : "passed");

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
