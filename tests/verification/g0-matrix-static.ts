// D08.3: the G0 matrix is checked without any report, so a renamed test or check cannot quietly
// turn a case into "line not found" only in CI. Every report it needs is a ready task; every
// check it names belongs to that task or one of its work orders; every line it looks for is
// written in the test or script that check runs (an F08 case title "<id> (<task>)" must be a
// declared case of that task). Each G0 item and each case of the DEV §9.6 matrix is present.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { verificationTasks, type CheckDefinition } from "../../tooling/verification-tasks.ts";
import { F08_FILE } from "../support/bootstrap-cases.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G0_CASES, G0_REPORTS } from "./g0-matrix.ts";

/** The failure matrix of DEV §9.6 and the items of G0 in §8.4/D08.3-AC1, by case ID. */
const REQUIRED_CASES = [
  "http", "status-screen", "restarts", "lease", "migration-snapshot-restore", "logs", "isolation",
  "env-error", "instance-json", "critical-mount-read-only", "logs-read-only", "symlink", "snapshot-no-space",
  "interrupted-init", "bad-checksum", "newer-database", "second-writer", "sigkill", "sigterm-timeout",
];

const ready = new Map(verificationTasks.flatMap((task) => (task.ready ? [[task.id, task] as const] : [])));
function checksOf(id: string): CheckDefinition[] {
  const task = ready.get(id);
  if (!task) return [];
  return [...task.checks, ...(task.steps ?? []).flatMap((step) => ready.get(step)?.checks ?? [])];
}

function sourceText(definition: CheckDefinition): string {
  const files = [...new Set([...definition.command, ...definition.requires].filter((arg) => arg.startsWith("tests/")))].flatMap((arg) => {
    const full = path.join(repoRoot, arg);
    return statSync(full).isDirectory() ? readdirSync(full, { recursive: true }).map(String).filter((name) => name.endsWith(".ts")).map((name) => path.join(full, name)) : [full];
  });
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

const f08: unknown = JSON.parse(readFileSync(F08_FILE, "utf8"));
const f08Titles = new Set(
  (typeof f08 === "object" && f08 !== null && Array.isArray(Reflect.get(f08, "cases")) ? (Reflect.get(f08, "cases") as unknown[]) : []).map((item) =>
    typeof item === "object" && item !== null ? `${String(Reflect.get(item, "id"))} (${String(Reflect.get(item, "task"))})` : "",
  ),
);

const check = createCheck("G0 matrix against the task map and the test sources");
check.expect(G0_REPORTS.every((id) => ready.has(id)), `the ${G0_REPORTS.length} reports G0 joins are ready tasks`, G0_REPORTS.filter((id) => !ready.has(id)).join(", "));
const ids = G0_CASES.map((item) => item.id);
check.expect(REQUIRED_CASES.every((id) => ids.includes(id)) && ids.length === new Set(ids).size, `all ${REQUIRED_CASES.length} G0 items and failure-matrix cases are present, once each`, REQUIRED_CASES.filter((id) => !ids.includes(id)).join(", "));
for (const item of G0_CASES) {
  const problems = item.evidence.flatMap((evidence) => {
    const definition = checksOf(evidence.task).find((candidate) => candidate.id === evidence.check);
    if (!definition) return [`${evidence.task} has no check ${evidence.check}`];
    const found = sourceText(definition).includes(evidence.source ?? evidence.line) || (evidence.check === "full-bootstrap-f08" && f08Titles.has(evidence.line));
    return found ? [] : [`"${evidence.source ?? evidence.line}" is not in the sources of ${evidence.check}`];
  });
  check.expect(item.evidence.length > 0 && problems.length === 0, `${item.group}: ${item.title} (${item.evidence.length} proofs)`, problems.join("\n"));
}
check.finish();
