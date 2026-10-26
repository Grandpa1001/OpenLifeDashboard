// D08.1-AC2: without Docker every container test stops as blocked (exit 78), never as a passed
// or quietly skipped check, and the runner turns that into a blocked criterion and a nonzero exit.
// The test scripts run with a PATH that holds no docker CLI; the runner gets an isolated task map.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isJsonObject } from "../../scripts/support/workspaces.ts";
import { BLOCKED_EXIT_CODE } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";

/** System tests that need no Docker: they join reports made elsewhere. */
const WITHOUT_DOCKER = new Set(["multiarch-reports.ts"]);

const check = createCheck("container tests without Docker");
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-no-docker-"));
try {
  // An empty directory as PATH: the docker CLI cannot be found, node is started by its own path.
  const emptyPath = path.join(scratch, "bin");
  const env = { ...process.env, PATH: emptyPath };
  const scripts = readdirSync(path.join(repoRoot, "tests/system")).filter((name) => name.endsWith(".ts") && !WITHOUT_DOCKER.has(name)).sort();
  check.expect(scripts.length > 0, `${scripts.length} container test scripts found`);
  for (const name of scripts) {
    const run = spawnSync(process.execPath, [path.join("tests/system", name)], { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000 });
    const output = `${run.stdout}${run.stderr}`;
    check.expect(
      run.status === BLOCKED_EXIT_CODE && output.includes("blocked: the docker CLI is not installed") && !/^\s+ok\s/m.test(output),
      `${name}: exit ${run.status}, blocked before any assertion`,
      output,
    );
  }

  // The runner on one such check: blocked criterion, blocked task, exit 1.
  const tasksFile = path.join(scratch, "tasks.mjs");
  const script = path.join(repoRoot, "tests/system", scripts[0] ?? "compose-local.ts");
  writeFileSync(
    tasksFile,
    `export const verificationTasks = ${JSON.stringify([
      {
        id: "X01",
        ready: true,
        title: "a container check without Docker",
        criteria: ["X01-AC1"],
        checks: [{ id: "container", criteria: ["X01-AC1"], description: "needs Docker", command: ["node", script], requires: [] }],
      },
    ])};\n`,
  );
  const artifacts = path.join(scratch, "artifacts");
  const runner = spawnSync(process.execPath, ["scripts/verify-task.ts", "--tasks", tasksFile, "--artifacts", artifacts, "X01"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  const [runDir] = readdirSync(artifacts);
  const report: unknown = runDir ? JSON.parse(readFileSync(path.join(artifacts, runDir, "verification.json"), "utf8")) : undefined;
  const criteria = isJsonObject(report) && Array.isArray(report["criteria"]) ? report["criteria"] : [];
  check.expect(runner.status === 1, `the runner exits 1 (got ${runner.status})`, `${runner.stdout}${runner.stderr}`);
  check.expect(
    isJsonObject(report) && report["result"] === "blocked" && JSON.stringify(criteria.map((item) => (isJsonObject(item) ? item["status"] : null))) === '["blocked"]',
    "the report says blocked for the task and its criterion, not passed or not_run",
    JSON.stringify(report),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
check.finish();
