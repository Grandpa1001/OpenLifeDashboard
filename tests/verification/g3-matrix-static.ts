// G3: the matrix is checked without any report, so a renamed test or check cannot quietly turn an
// item into "line not found" only in CI. Every report it needs is a ready task; every check it names
// belongs to that task; every line it looks for is written, as it stands, in the tests that check runs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { verificationTasks, type CheckDefinition } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G3_ITEMS, G3_REPORTS } from "./g3-matrix.ts";

/** The items of G3 in DEV §8.4 and §9.37. */
const REQUIRED_ITEMS = ["record-a-to-b", "layout-a-to-b", "stream-reconnect", "session-end", "dst-clocks", "widget-isolation", "save-failure", "drag-touch", "ten-widgets", "preview"];

const ready = new Map(verificationTasks.flatMap((task) => (task.ready ? [[task.id, task] as const] : [])));

/** The sources a check runs: test files and folders it names, and for a browser check the spec files of its filters. */
function sourceText(definition: CheckDefinition): string {
  const specs = definition.command[1] === "tests/verification/e2e.ts" ? readdirSync(path.join(repoRoot, "tests/e2e")).filter((name) => definition.command.slice(2).some((filter) => name.includes(filter))).map((name) => `tests/e2e/${name}`) : [];
  const files = [...new Set([...definition.command, ...definition.requires, ...specs].filter((arg) => arg.startsWith("tests/")))].flatMap((arg) => {
    const full = path.join(repoRoot, arg);
    return statSync(full).isDirectory() ? readdirSync(full, { recursive: true }).map(String).filter((name) => name.endsWith(".ts")).map((name) => path.join(full, name)) : [full];
  });
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

const check = createCheck("G3 matrix against the task map and the test sources");
check.expect(G3_REPORTS.every((id) => ready.has(id)), `the ${G3_REPORTS.length} reports G3 joins are ready tasks`, G3_REPORTS.filter((id) => !ready.has(id)).join(", "));
const ids = G3_ITEMS.map((item) => item.id);
check.expect(REQUIRED_ITEMS.every((id) => ids.includes(id)) && ids.length === new Set(ids).size, `all ${REQUIRED_ITEMS.length} items of G3 are present, once each`, REQUIRED_ITEMS.filter((id) => !ids.includes(id)).join(", "));
check.expect(new Set(G3_ITEMS.flatMap((item) => item.evidence.map((evidence) => evidence.task))).size === G3_REPORTS.length, "every report G3 joins proves at least one item, and no item names a report outside the list");
for (const item of G3_ITEMS) {
  const problems = item.evidence.flatMap((evidence) => {
    const definition = ready.get(evidence.task)?.checks.find((candidate) => candidate.id === evidence.check);
    if (!definition) return [`${evidence.task} has no check ${evidence.check}`];
    return sourceText(definition).includes(evidence.line) ? [] : [`"${evidence.line}" is not in the sources of ${evidence.task} ${evidence.check}`];
  });
  check.expect(item.evidence.length > 0 && problems.length === 0, `G3: ${item.title} (${item.evidence.length} proofs)`, problems.join("\n"));
}
check.finish();
