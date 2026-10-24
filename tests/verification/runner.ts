// D01.3-AC1…AC3 for the runner itself, on an isolated task map in a temp dir (DEV §9.4: the
// runner never calls its own verify:task). Covers the report fields, passed / failed /
// blocked results, a removed required script, an uncovered criterion, a not-ready task,
// an unknown ID, a malformed map and parent gating by its work orders.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isJsonObject } from "../../scripts/support/workspaces.ts";
import { BLOCKED_EXIT_CODE, EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot, runNode } from "../support/repository-copy.ts";

const RUNNER = path.join(repoRoot, "scripts/verify-task.ts");

const check = (id: string, script: string, criteria: string[]) => ({
  id,
  criteria,
  description: `runs ${script}`,
  command: ["node", script],
  requires: [script],
});

const TASKS = [
  {
    id: "X01",
    ready: true,
    title: "parent with a failing work order",
    steps: ["X01.1", "X01.2"],
    criteria: ["X01-smoke"],
    checks: [check("smoke-x01", "ok.mjs", ["X01-smoke"])],
  },
  { id: "X01.1", ready: true, title: "passing", criteria: ["X01.1-AC1"], checks: [check("ok", "ok.mjs", ["X01.1-AC1"])] },
  { id: "X01.2", ready: true, title: "failing", criteria: ["X01.2-AC1"], checks: [check("fail", "fail.mjs", ["X01.2-AC1"])] },
  { id: "X02", ready: true, title: "removable script", criteria: ["X02-AC1"], checks: [check("gone", "gone.mjs", ["X02-AC1"])] },
  {
    id: "X03",
    ready: true,
    title: "uncovered criterion",
    criteria: ["X03-AC1", "X03-AC2"],
    checks: [check("partial", "ok.mjs", ["X03-AC1"])],
  },
  { id: "X04", ready: false },
  {
    id: "X08",
    ready: true,
    title: "parent whose steps share a check",
    steps: ["X08.1", "X08.2"],
    criteria: ["X08-smoke"],
    checks: [check("smoke-x08", "ok.mjs", ["X08-smoke"])],
  },
  { id: "X08.1", ready: true, title: "shared a", criteria: ["X08.1-AC1"], checks: [check("shared", "ok.mjs", ["X08.1-AC1"])] },
  { id: "X08.2", ready: true, title: "shared b", criteria: ["X08.2-AC1"], checks: [check("shared", "ok.mjs", ["X08.2-AC1"])] },
  {
    id: "X07",
    ready: true,
    title: "evidence",
    criteria: ["X07-AC1"],
    checks: [check("evidence", "evidence.mjs", ["X07-AC1"])],
  },
  {
    id: "X06",
    ready: true,
    title: "missing precondition",
    criteria: ["X06-AC1"],
    checks: [check("precondition", "precondition.mjs", ["X06-AC1"])],
  },
  {
    id: "X05",
    ready: true,
    title: "parent whose work orders pass",
    steps: ["X01.1"],
    criteria: ["X05-smoke"],
    checks: [check("smoke-x05", "ok.mjs", ["X05-smoke"])],
  },
];

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openlife-runner-")));
const write = (file: string, content: string): void => writeFileSync(path.join(root, file), content);
write("ok.mjs", 'console.log("ok");\n');
write("fail.mjs", "process.exit(3);\n");
write("gone.mjs", "process.exit(0);\n");
write("precondition.mjs", `process.exit(${BLOCKED_EXIT_CODE});\n`);
write(
  "evidence.mjs",
  `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.${EVIDENCE_DIR_ENV} + "/responses.json", "[]");\n`,
);
write("tasks.mjs", `export const verificationTasks = ${JSON.stringify(TASKS, null, 2)};\n`);
write(
  "malformed.mjs",
  `export const verificationTasks = ${JSON.stringify([
    { id: "Y01", ready: true, title: "check covers an undeclared criterion", criteria: ["Y01-AC1"], checks: [check("y", "ok.mjs", ["Y01-AC9"])] },
  ])};\n`,
);

let call = 0;
function verify(id: string, tasks = "tasks.mjs"): { status: number | null; output: string; report: Record<string, unknown> | null } {
  call += 1;
  const artifacts = path.join(root, "artifacts", String(call));
  const result = runNode([RUNNER, "--root", root, "--tasks", path.join(root, tasks), "--artifacts", artifacts, id], root);
  const runs = (() => {
    try {
      return readdirSync(artifacts);
    } catch {
      return [];
    }
  })();
  const reportFile = runs[0] ? path.join(artifacts, runs[0], "verification.json") : undefined;
  const parsed: unknown = reportFile ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
  return { ...result, report: isJsonObject(parsed) ? (parsed as Record<string, unknown>) : null };
}

const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isJsonObject).map((item) => item as Record<string, unknown>) : [];
const criterion = (report: Record<string, unknown> | null, id: string): unknown =>
  asArray(report?.["criteria"]).find((entry) => entry["id"] === id)?.["status"];

const t = createCheck("verify:task runner");
try {
  const passed = verify("X01.1");
  t.expect(passed.status === 0 && passed.report?.["result"] === "passed", "passing check → result passed, exit 0", passed.output);
  const okCheck = asArray(passed.report?.["checks"])[0];
  t.expect(okCheck?.["exitCode"] === 0 && typeof okCheck["durationMs"] === "number", "report records the exit code and duration");
  t.expect(
    JSON.stringify(okCheck?.["command"]) === JSON.stringify(["node", "ok.mjs"]) && typeof okCheck?.["log"] === "string",
    "report records the command and a log path",
  );
  const okHash = createHash("sha256").update(readFileSync(path.join(root, "ok.mjs"))).digest("hex");
  t.expect(
    asArray(passed.report?.["inputs"]).some((input) => input["path"] === "ok.mjs" && input["sha256"] === okHash),
    "report hashes the check inputs",
  );
  const environment = passed.report?.["environment"];
  t.expect(isJsonObject(environment) && environment["node"] === process.version, "report records the Node version");
  t.expect(isJsonObject(passed.report?.["code"]), "report records the code version / working-tree state");
  t.expect(isJsonObject(passed.report?.["taskMap"]), "report records the task map and its hash");

  const failed = verify("X01.2");
  const failCheck = asArray(failed.report?.["checks"])[0];
  t.expect(failed.status === 1 && failed.report?.["result"] === "failed", "failing check → result failed, exit 1", failed.output);
  t.expect(failCheck?.["exitCode"] === 3, "the check's own exit code is kept (3)");

  const present = verify("X02");
  t.expect(present.status === 0, "the removable script passes while it exists", present.output);
  unlinkSync(path.join(root, "gone.mjs"));
  const removed = verify("X02");
  const goneCheck = asArray(removed.report?.["checks"])[0];
  t.expect(removed.status === 1 && removed.report?.["result"] === "blocked", "removed required script → blocked, exit 1", removed.output);
  t.expect(goneCheck?.["exitCode"] === null && String(goneCheck?.["reason"]).includes("gone.mjs"), "blocked check names the missing file");

  const uncovered = verify("X03");
  t.expect(uncovered.status === 1 && criterion(uncovered.report, "X03-AC2") === "blocked", "criterion without a check → blocked, exit 1");

  const withEvidence = verify("X07");
  const evidenceCheck = asArray(withEvidence.report?.["checks"])[0];
  t.expect(
    withEvidence.status === 0 &&
      JSON.stringify(evidenceCheck?.["evidence"]) === JSON.stringify(["evidence/evidence/responses.json"]),
    "files a check saves in its evidence directory are listed in the report",
    withEvidence.output,
  );

  const shared = verify("X08");
  t.expect(
    shared.status === 0 &&
      criterion(shared.report, "X08.1-AC1") === "passed" &&
      criterion(shared.report, "X08.2-AC1") === "passed" &&
      asArray(shared.report?.["checks"]).filter((c) => c["id"] === "shared").length === 1,
    "a check shared by two work orders runs once and covers both criteria",
    shared.output,
  );

  const precondition = verify("X06");
  t.expect(
    precondition.status === 1 && precondition.report?.["result"] === "blocked",
    `check exiting ${BLOCKED_EXIT_CODE} (missing precondition) → blocked, not failed`,
    precondition.output,
  );

  const notReady = verify("X04");
  t.expect(notReady.status === 1 && notReady.report?.["result"] === "blocked", "not-ready task → blocked, exit 1, no empty pass");

  const unknown = verify("X99");
  t.expect(unknown.status === 2 && unknown.report === null, "unknown ID → rejected with exit 2 and no report", unknown.output);

  const malformed = verify("Y01", "malformed.mjs");
  t.expect(malformed.status === 2 && malformed.report === null, "malformed task map → rejected with exit 2", malformed.output);

  const gated = verify("X01");
  t.expect(
    gated.status === 1 && gated.report?.["result"] === "failed" && criterion(gated.report, "X01-smoke") === "passed",
    "parent fails when a work order fails, even if its smoke passes",
    gated.output,
  );
  const parentPassed = verify("X05");
  t.expect(
    parentPassed.status === 0 && criterion(parentPassed.report, "X01.1-AC1") === "passed",
    "parent passes only with its work-order criteria and smoke",
    parentPassed.output,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
t.finish();
