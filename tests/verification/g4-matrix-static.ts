// G4: the matrix is checked without any report, so a renamed test or check cannot quietly turn an
// item into "line not found" only in CI. Every report it needs is a ready task; every check it names
// belongs to that task; every line it looks for is written, as it stands, in the tests that check runs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { verificationTasks, type CheckDefinition } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { G4_ITEMS, G4_REPORTS } from "./g4-matrix.ts";

/** The items of G4 in DEV §8.4 and §9.45. */
const REQUIRED_ITEMS = ["settings-persist", "settings-locks", "account-security", "diagnostics-no-secrets", "export-clean", "import-roundtrip", "f04-f05", "bad-file", "one-choice", "instance-responsive", "import-no-secrets", "screen-template"];

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

const check = createCheck("G4 matrix against the task map and the test sources");
check.expect(G4_REPORTS.every((id) => ready.has(id)), `the ${G4_REPORTS.length} reports G4 joins are ready tasks`, G4_REPORTS.filter((id) => !ready.has(id)).join(", "));
const ids = G4_ITEMS.map((item) => item.id);
check.expect(REQUIRED_ITEMS.every((id) => ids.includes(id)) && ids.length === new Set(ids).size, `all ${REQUIRED_ITEMS.length} items of G4 are present, once each`, REQUIRED_ITEMS.filter((id) => !ids.includes(id)).join(", "));
check.expect(new Set(G4_ITEMS.flatMap((item) => item.evidence.map((evidence) => evidence.task))).size === G4_REPORTS.length, "every report G4 joins proves at least one item, and no item names a report outside the list");
for (const item of G4_ITEMS) {
  const problems = item.evidence.flatMap((evidence) => {
    const definition = ready.get(evidence.task)?.checks.find((candidate) => candidate.id === evidence.check);
    if (!definition) return [`${evidence.task} has no check ${evidence.check}`];
    return sourceText(definition).includes(evidence.line) ? [] : [`"${evidence.line}" is not in the sources of ${evidence.task} ${evidence.check}`];
  });
  check.expect(item.evidence.length > 0 && problems.length === 0, `G4: ${item.title} (${item.evidence.length} proofs)`, problems.join("\n"));
}
check.finish();
