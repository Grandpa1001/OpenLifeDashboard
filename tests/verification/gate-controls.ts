// The controls of a gate on synthetic report folders (it never reads real results here): a complete
// set of passed reports for this code, whose logs hold every line of the matrix, passes; each
// deviation gets its own verdict: a failed test line or a failed check fails, a missing line fails (a
// renamed test is not a pass), a missing report or one of other code is blocked. Used by G1 and G2.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import type { GateMatrix } from "./gate-run.ts";

export type GateVariant = Readonly<{
  drop?: string;
  otherCode?: string;
  failedCheck?: string;
  /** Rewrites the log line of the first evidence of this item. */
  line?: Readonly<{ itemId: string; to: (line: string) => string }>;
}>;
/** A deviation, the exit it must end with and a text its output must hold. */
export type GateCase = readonly [name: string, variant: GateVariant, status: number, text: string];

export const BLOCKED = BLOCKED_EXIT_CODE;

export function checkGate(matrix: GateMatrix, script: string, cases: readonly GateCase[]): void {
  const code = describeCode(repoRoot);
  const scratch = mkdtempSync(path.join(os.tmpdir(), `openlife-${matrix.gate.toLowerCase()}-controls-`));

  function writeReports(name: string, variant: GateVariant): string {
    const dir = path.join(scratch, name);
    const changed = matrix.items.find((item) => item.id === variant.line?.itemId)?.evidence[0];
    for (const task of matrix.reports.filter((id) => id !== variant.drop)) {
      const runDir = path.join(dir, `run-${task}`);
      mkdirSync(path.join(runDir, "checks"), { recursive: true });
      const lines = new Map<string, string[]>();
      for (const evidence of matrix.items.flatMap((item) => item.evidence).filter((each) => each.task === task)) {
        const passed = ` ✓ synthetic > ${evidence.line} 1ms`;
        const text = evidence === changed && variant.line ? variant.line.to(passed) : passed;
        lines.set(evidence.check, [...(lines.get(evidence.check) ?? []), text]);
      }
      const checks = [...lines].map(([id, logLines]) => {
        writeFileSync(path.join(runDir, "checks", `${id}.log`), `${logLines.join("\n")}\n`);
        return { id, status: id === variant.failedCheck ? "failed" : "passed", log: `checks/${id}.log` };
      });
      const reportCode = task === variant.otherCode ? { ...code, commit: "0".repeat(40) } : code;
      writeFileSync(
        path.join(runDir, "verification.json"),
        JSON.stringify({ task, runId: `synthetic-${task}`, result: variant.failedCheck ? "failed" : "passed", finishedAt: "2026-10-28T00:00:00.000Z", code: reportCode, checks }),
      );
    }
    return dir;
  }

  function gate(dir: string): { status: number | null; output: string } {
    const run = spawnSync(process.execPath, [script], { cwd: repoRoot, env: { ...process.env, [matrix.reportsDirEnv]: dir, OPENLIFE_VERIFY_EVIDENCE_DIR: "" }, encoding: "utf8" });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  }

  const count = matrix.items.length;
  const check = createCheck(`${matrix.gate} gate on synthetic reports`);
  try {
    const complete = gate(writeReports("complete", {}));
    check.expect(complete.status === 0 && complete.output.includes(`${matrix.gate} passed: ${count} of ${count} items passed`), `every report and line present and passed → ${matrix.gate} passed`, complete.output);
    check.expect(matrix.items.every((item) => item.evidence.length > 0), `every item of ${matrix.gate} names the evidence that proves it`);
    for (const [name, variant, status, text] of cases) {
      const result = gate(writeReports(name.replace(/\W+/g, "-"), variant));
      check.expect(result.status === status && result.output.includes(text), `${name} → exit ${status}: "${text}"`, result.output);
      check.expect(new RegExp(`${matrix.gate} (failed|blocked): \\d+ of ${count} items passed`).test(result.output), `${name}: the result still lists all ${count} items`, result.output);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  check.finish();
}
