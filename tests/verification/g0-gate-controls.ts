// D08.3: the G0 gate on synthetic report folders (it never reads real results here). A complete
// set of passed reports for this code, whose logs hold every line of the matrix, passes; each
// deviation gets its own verdict: a failed test line or a failed check fails, a missing line
// fails (a renamed test is not a pass), a missing report or one of other code is blocked.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G0_CASES, G0_REPORTS, type G0Report } from "./g0-matrix.ts";

type Variant = Readonly<{
  drop?: G0Report;
  otherCode?: G0Report;
  failedCheck?: string;
  /** Rewrites the log line of the first evidence of this case. */
  line?: Readonly<{ caseId: string; to: (line: string) => string }>;
}>;

const code = describeCode(repoRoot);
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-g0-controls-"));

function writeReports(name: string, variant: Variant): string {
  const dir = path.join(scratch, name);
  const changed = G0_CASES.find((item) => item.id === variant.line?.caseId)?.evidence[0];
  for (const task of G0_REPORTS.filter((id) => id !== variant.drop)) {
    const runDir = path.join(dir, `run-${task}`);
    mkdirSync(path.join(runDir, "checks"), { recursive: true });
    const lines = new Map<string, string[]>();
    for (const evidence of G0_CASES.flatMap((item) => item.evidence).filter((each) => each.task === task)) {
      const passed = ` ✓ synthetic > ${evidence.line} 1ms`;
      const line = evidence === changed && variant.line ? variant.line.to(passed) : passed;
      lines.set(evidence.check, [...(lines.get(evidence.check) ?? []), line]);
    }
    const checks = [...lines].map(([id, logLines]) => {
      writeFileSync(path.join(runDir, "checks", `${id}.log`), `${logLines.join("\n")}\n`);
      return { id, status: id === variant.failedCheck ? "failed" : "passed", log: `checks/${id}.log` };
    });
    const reportCode = task === variant.otherCode ? { ...code, commit: "0".repeat(40) } : code;
    writeFileSync(
      path.join(runDir, "verification.json"),
      JSON.stringify({ task, runId: `synthetic-${task}`, result: variant.failedCheck ? "failed" : "passed", finishedAt: "2026-10-26T00:00:00.000Z", code: reportCode, checks }),
    );
  }
  return dir;
}

function gate(dir: string): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, ["tests/verification/g0-gate.ts"], {
    cwd: repoRoot,
    env: { ...process.env, OPENLIFE_G0_REPORTS_DIR: dir, OPENLIFE_VERIFY_EVIDENCE_DIR: "" },
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const check = createCheck("G0 gate on synthetic reports");
try {
  const complete = gate(writeReports("complete", {}));
  check.expect(complete.status === 0 && complete.output.includes(`G0 passed: ${G0_CASES.length} of ${G0_CASES.length} cases passed`), "every report and line present and passed → G0 passed", complete.output);

  const cases: ReadonlyArray<readonly [string, Variant, number, string]> = [
    ["a failed test line", { line: { caseId: "sigterm-timeout", to: (line) => line.replace("✓", "×") } }, 1, "failed  failure matrix: SIGTERM with a timeout"],
    ["a line no longer in the log (renamed test)", { line: { caseId: "symlink", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  failure matrix: a symlink out of the mount"],
    ["a failed check", { failedCheck: "compose-isolation-native" }, 1, "failed  G0: two installations A/B stay apart"],
    ["a missing report", { drop: "D05" }, BLOCKED_EXIT_CODE, "blocked failure matrix: no space while taking a snapshot"],
    ["a report of other code", { otherCode: "D04" }, BLOCKED_EXIT_CODE, "blocked report D04 — none for this code"],
  ];
  for (const [name, variant, status, line] of cases) {
    const result = gate(writeReports(name.replace(/\W+/g, "-"), variant));
    check.expect(result.status === status && result.output.includes(line), `${name} → exit ${status}: "${line}"`, result.output);
    check.expect(new RegExp(`G0 (failed|blocked): \\d+ of ${G0_CASES.length} cases passed`).test(result.output), `${name}: the result still lists all ${G0_CASES.length} cases`, result.output);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
check.finish();
