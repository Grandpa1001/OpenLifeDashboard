// D20.3: the G1 gate on synthetic report folders (it never reads real results here). A complete set
// of passed reports for this code, whose logs hold every line of the matrix, passes; each deviation
// gets its own verdict: a failed test line or a failed check fails, a missing line fails (a renamed
// test is not a pass), a missing report or one of other code is blocked.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G1_ITEMS, G1_REPORTS } from "./g1-matrix.ts";

type Report = (typeof G1_REPORTS)[number];
type Variant = Readonly<{
  drop?: Report;
  otherCode?: Report;
  failedCheck?: string;
  /** Rewrites the log line of the first evidence of this item. */
  line?: Readonly<{ itemId: string; to: (line: string) => string }>;
}>;

const code = describeCode(repoRoot);
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-g1-controls-"));

function writeReports(name: string, variant: Variant): string {
  const dir = path.join(scratch, name);
  const changed = G1_ITEMS.find((item) => item.id === variant.line?.itemId)?.evidence[0];
  for (const task of G1_REPORTS.filter((id) => id !== variant.drop)) {
    const runDir = path.join(dir, `run-${task}`);
    mkdirSync(path.join(runDir, "checks"), { recursive: true });
    const lines = new Map<string, string[]>();
    for (const evidence of G1_ITEMS.flatMap((item) => item.evidence).filter((each) => each.task === task)) {
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
  const run = spawnSync(process.execPath, ["tests/verification/g1-gate.ts"], {
    cwd: repoRoot,
    env: { ...process.env, OPENLIFE_G1_REPORTS_DIR: dir, OPENLIFE_VERIFY_EVIDENCE_DIR: "" },
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const check = createCheck("G1 gate on synthetic reports");
try {
  const complete = gate(writeReports("complete", {}));
  check.expect(complete.status === 0 && complete.output.includes(`G1 passed: ${G1_ITEMS.length} of ${G1_ITEMS.length} items passed`), "every report and line present and passed → G1 passed", complete.output);
  check.expect(G1_ITEMS.every((item) => item.evidence.length > 0), "every item of G1 names the evidence that proves it");

  const cases: ReadonlyArray<readonly [string, Variant, number, string]> = [
    ["a failed test line", { line: { itemId: "login-totp", to: (text) => text.replace("✓", "×") } }, 1, "failed  G1: login-totp"],
    ["a line no longer in the log (renamed test)", { line: { itemId: "widget", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  G1: widget"],
    ["a failed check", { failedCheck: "data-routes-access" }, 1, "failed  G1: no-way-around"],
    ["a missing report", { drop: "D20.1" }, BLOCKED_EXIT_CODE, "blocked report D20.1 — none for this code"],
    ["a report of other code", { otherCode: "D19.3" }, BLOCKED_EXIT_CODE, "blocked G1: installation"],
  ];
  for (const [name, variant, status, text] of cases) {
    const result = gate(writeReports(name.replace(/\W+/g, "-"), variant));
    check.expect(result.status === status && result.output.includes(text), `${name} → exit ${status}: "${text}"`, result.output);
    check.expect(new RegExp(`G1 (failed|blocked): \\d+ of ${G1_ITEMS.length} items passed`).test(result.output), `${name}: the result still lists all ${G1_ITEMS.length} items`, result.output);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
check.finish();
