// D01.3-AC3 (static part): CI installs from the frozen lockfile on the pinned runtime and runs
// the same `verify:task` runner for D01; since D08.1 also for every ready task of the map.
// Whether GitHub actually ran it is visible only in the workflow run, not from this check.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { isJsonObject, readJsonObject } from "../../scripts/support/workspaces.ts";
import { verificationTasks } from "../../tooling/verification-tasks.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const scripts = readJsonObject(path.join(repoRoot, "package.json"))["scripts"];
const steps = workflow.split("\n").map((line) => line.trim());

const check = createCheck("CI workflow");
// GitHub rejects an unparsable workflow before any job starts, so no report would show it.
const parseErrors = parseDocument(workflow).errors.map((error) => error.message);
check.expect(parseErrors.length === 0, "the workflow is valid YAML", parseErrors.join("\n"));
check.expect(
  isJsonObject(scripts) && scripts["verify:task"] === "node scripts/verify-task.ts",
  "package.json verify:task runs scripts/verify-task.ts",
);
check.expect(steps.includes("run: pnpm install --frozen-lockfile"), "CI installs with --frozen-lockfile");
check.expect(steps.includes("run: pnpm verify:task -- D01"), "CI runs pnpm verify:task -- D01");
check.expect(steps.includes("node-version-file: .node-version"), "CI uses the Node version from .node-version");
check.expect(steps.includes("run: pnpm verify:task -- D02.2"), "CI runs pnpm verify:task -- D02.2");
check.expect(
  steps.includes("- runner: ubuntu-24.04") && steps.includes("- runner: ubuntu-24.04-arm"),
  "the image job runs on native amd64 and arm64 runners",
);
const actions = steps.filter((line) => line.startsWith("uses:") || line.startsWith("- uses:"));
check.expect(
  actions.length > 0 && actions.every((line) => /@[0-9a-f]{40}\b/.test(line)),
  `every action is pinned to a commit SHA (${actions.length} actions)`,
);
check.expect(/^permissions:\n\s+contents: read$/m.test(workflow), "the workflow token is read-only");
check.expect(
  steps.includes("path: .artifacts/") && steps.includes("include-hidden-files: true"),
  "the .artifacts report directory is uploaded (dot-directories are skipped by default)",
);

// D08.1-AC1: every task the map can verify is run by CI, itself or through its parent.
// D00 checks the local, unversioned specification (Analiza/), which a CI checkout does not have.
const NOT_IN_CI = new Set(["D00"]);
const ran = new Set(steps.flatMap((line) => /^run: pnpm verify:task -- (\S+)$/.exec(line)?.slice(1) ?? []));
const ready = verificationTasks.filter((task) => task.ready);
const parentOf = new Map(ready.flatMap((task) => (task.steps ?? []).map((step) => [step, task.id] as const)));
const missing = ready.map((task) => task.id).filter((id) => !NOT_IN_CI.has(id) && !ran.has(id) && !ran.has(parentOf.get(id) ?? ""));
check.expect(missing.length === 0, `CI runs every ready task of the map (${ready.length - NOT_IN_CI.size})`, `not run by CI: ${missing.join(", ")}`);
check.finish();
