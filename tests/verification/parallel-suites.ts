// D08.1-AC1: tests keep to their own folders and ports. The unit and integration suites run twice
// at the same time on one host, like two CI jobs or two developers' runs; both must pass, every
// declared test must have run (a skipped or todo test is not a pass) and no temporary folder of
// a test may be left behind. Each run already runs its own files in parallel workers.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pnpmInvocation } from "../../scripts/support/toolchain.ts";
import { isJsonObject } from "../../scripts/support/workspaces.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";

const RUNS = 2;
/** Test folders are created under the OS temp dir with this prefix. */
const TEST_DIR_PREFIX = "openlife-";

const tempDirs = (): string[] => readdirSync(realpathSync(os.tmpdir())).filter((name) => name.startsWith(TEST_DIR_PREFIX)).sort();

function runSuites(reportFile: string): Promise<{ status: number | null; output: string }> {
  const invocation = pnpmInvocation(["exec", "vitest", "run", "tests/unit", "tests/integration", "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`]);
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, { cwd: repoRoot });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("close", (status) => resolve({ status, output }));
  });
}

const check = createCheck(`${RUNS} unit + integration runs at the same time`);
const scratch = mkdtempSync(path.join(os.tmpdir(), "parallel-suites-"));
try {
  const before = tempDirs();
  const reports = Array.from({ length: RUNS }, (_, index) => path.join(scratch, `run-${index + 1}.json`));
  const runs = await Promise.all(reports.map(runSuites));
  runs.forEach((run, index) => {
    const name = `run ${index + 1}`;
    check.expect(run.status === 0, `${name}: vitest exits 0`, run.output);
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(reports[index] ?? "", "utf8"));
    } catch {
      report = undefined;
    }
    const count = (key: string): number => (isJsonObject(report) && typeof report[key] === "number" ? report[key] : -1);
    check.expect(
      count("numTotalTests") > 0 && count("numPassedTests") === count("numTotalTests") && count("numPendingTests") === 0 && count("numTodoTests") === 0,
      `${name}: ${count("numPassedTests")} of ${count("numTotalTests")} tests passed, none skipped or todo`,
      JSON.stringify({ total: count("numTotalTests"), passed: count("numPassedTests"), failed: count("numFailedTests"), skipped: count("numPendingTests"), todo: count("numTodoTests") }),
    );
  });
  const left = tempDirs().filter((name) => !before.includes(name));
  check.expect(left.length === 0, "no test folder is left in the temp dir", left.join("\n"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
check.finish();
