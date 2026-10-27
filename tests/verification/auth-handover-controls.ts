// D13.3: the auth and setup handover on synthetic report folders (it never reads real results
// here). A complete set of passed reports for this code, whose logs hold every line of the matrix,
// passes; each deviation gets its own verdict: a failed test line, a failed check, a missing
// mandatory line (a renamed test is not a pass), a flow of the fixture without evidence and a
// wrong number of policy cases fail; a missing report or one of other code is blocked.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { FLOW_EVIDENCE, HANDOVER_REPORTS, MANDATORY_EVIDENCE, POLICY_EVIDENCE } from "./auth-handover-matrix.ts";

type FixtureContent = { flows: Array<{ id: string; task: string }>; policyCases: unknown[] };
type Variant = Readonly<{
  drop?: string;
  otherCode?: string;
  failedCheck?: string;
  /** Rewrites the log line of the first evidence of this item. */
  line?: Readonly<{ itemId: string; to: (line: string) => string }>;
  fixture?: (content: FixtureContent) => void;
}>;

const ITEMS = [...FLOW_EVIDENCE, ...POLICY_EVIDENCE, ...MANDATORY_EVIDENCE];
const code = describeCode(repoRoot);
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-handover-controls-"));
const realFixture = path.join(repoRoot, "tests/fixtures/cases/auth-v1.cases.json");

function write(name: string, variant: Variant): { dir: string; fixture: string } {
  const dir = path.join(scratch, name);
  const changed = ITEMS.find((item) => item.id === variant.line?.itemId)?.evidence[0];
  for (const task of HANDOVER_REPORTS.filter((id) => id !== variant.drop)) {
    const runDir = path.join(dir, `run-${task}`);
    mkdirSync(path.join(runDir, "checks"), { recursive: true });
    const lines = new Map<string, string[]>();
    for (const evidence of ITEMS.flatMap((item) => item.evidence).filter((each) => each.task === task)) {
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
      JSON.stringify({ task, runId: `synthetic-${task}`, result: variant.failedCheck ? "failed" : "passed", finishedAt: "2026-10-27T00:00:00.000Z", code: reportCode, checks }),
    );
  }
  const content = JSON.parse(readFileSync(realFixture, "utf8")) as FixtureContent;
  variant.fixture?.(content);
  const fixture = path.join(dir, "fixture.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(fixture, JSON.stringify(content));
  return { dir, fixture };
}

function gate(input: { dir: string; fixture: string }): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, ["tests/verification/auth-handover.ts"], {
    cwd: repoRoot,
    env: { ...process.env, OPENLIFE_HANDOVER_REPORTS_DIR: input.dir, OPENLIFE_HANDOVER_FIXTURE: input.fixture, OPENLIFE_VERIFY_EVIDENCE_DIR: "" },
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const check = createCheck("auth handover on synthetic reports");
try {
  const complete = gate(write("complete", {}));
  check.expect(complete.status === 0 && complete.output.includes(`handover passed: ${ITEMS.length} of ${ITEMS.length} items passed`), "every report and line present and passed → handover passed", complete.output);
  check.expect(/adapters: better-auth \d/.test(complete.output) && complete.output.includes("not run:"), "the report names the adapter versions and what was not run", complete.output);

  const cases: ReadonlyArray<readonly [string, Variant, number, string]> = [
    ["a failed test line of a flow", { line: { itemId: "parallel-totp-use", to: (line) => line.replace("✓", "×") } }, 1, "failed  F09 flow: parallel-totp-use"],
    ["a flow test renamed away from its line", { line: { itemId: "client-cannot-forge-assurance", to: () => " ✓ synthetic > a renamed test 1ms" } }, 1, "failed  F09 flow: client-cannot-forge-assurance"],
    ["the replay test is gone", { line: { itemId: "replay", to: () => " ✓ synthetic > something else 1ms" } }, 1, "failed  mandatory: replay"],
    ["the Origin test is gone", { line: { itemId: "origin", to: () => " ✓ synthetic > something else 1ms" } }, 1, "failed  mandatory: origin"],
    ["a failed check", { failedCheck: "request-authority" }, 1, "failed  F09 flow: logout-before-protected-commit"],
    ["a flow of the fixture with no evidence", { fixture: (content) => void content.flows.push({ id: "a-new-flow", task: "D99" }) }, 1, "failed  F09 flow: a-new-flow"],
    ["a flow removed from the fixture", { fixture: (content) => void content.flows.pop() }, 1, "which is not a flow of the fixture"],
    ["fewer policy cases", { fixture: (content) => void content.policyCases.pop() }, 1, "the fixture has 30 policy cases"],
    ["a missing report", { drop: "D12" }, BLOCKED_EXIT_CODE, "blocked report D12 — none for this code"],
    ["a report of other code", { otherCode: "D11" }, BLOCKED_EXIT_CODE, "blocked report D11 — none for this code"],
  ];
  for (const [name, variant, status, line] of cases) {
    const result = gate(write(name.replace(/\W+/g, "-"), variant));
    check.expect(result.status === status && result.output.includes(line), `${name} → exit ${status}: "${line}"`, result.output);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
check.finish();
