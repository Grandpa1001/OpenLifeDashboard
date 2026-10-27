// Joining verify:task reports (DEV §8.4): the reports a gate reads, the one per task that belongs
// to exactly the code being checked, and the verdict on one piece of evidence — a check that
// passed and whose log holds a passed line of the named test. Used by gate G0 (D08.3) and by the
// auth and setup handover (D13.3); neither runs a test, both read what the reports recorded.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";

export type Verdict = "passed" | "failed" | "blocked";
export type Loaded = Readonly<{ file: string; report: JsonObject }>;
/** A report-bound piece of evidence: the task whose report, the check in it and the line its log must hold. */
export type Evidence = Readonly<{ task: string; check: string; line: string }>;

/** A passed vitest/Playwright test (✓) or an "ok" assertion of a system script. */
const PASSED_LINE = /✓|^\s*ok\s/;

export function loadReports(reportsDir: string): Loaded[] {
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

/** The latest report of each task that refers to exactly this code. */
export function latestReports(loaded: readonly Loaded[], tasks: readonly string[], code: unknown): Map<string, Loaded> {
  const sameCode = (value: unknown): boolean => JSON.stringify(value) === JSON.stringify(code);
  const found = new Map<string, Loaded>();
  for (const task of tasks) {
    const latest = loaded
      .filter(({ report }) => report["task"] === task && sameCode(report["code"]))
      .sort((a, b) => String(a.report["finishedAt"]).localeCompare(String(b.report["finishedAt"])))
      .at(-1);
    if (latest) found.set(task, latest);
  }
  return found;
}

export function judgeEvidence(reports: ReadonlyMap<string, Loaded>, evidence: Evidence): Readonly<{ verdict: Verdict; detail: string }> {
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

export const worst = (verdicts: readonly Verdict[]): Verdict => (verdicts.includes("failed") ? "failed" : verdicts.includes("blocked") ? "blocked" : "passed");
