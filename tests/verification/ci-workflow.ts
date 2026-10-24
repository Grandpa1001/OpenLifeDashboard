// D01.3-AC3 (static part): CI installs from the frozen lockfile on the pinned runtime and runs
// the same `verify:task` runner for D01. Whether GitHub actually ran it is visible only in the
// workflow run, not from this repository check.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject, readJsonObject } from "../../scripts/support/workspaces.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
const scripts = readJsonObject(path.join(repoRoot, "package.json"))["scripts"];
const steps = workflow.split("\n").map((line) => line.trim());

const check = createCheck("CI workflow");
check.expect(
  isJsonObject(scripts) && scripts["verify:task"] === "node scripts/verify-task.ts",
  "package.json verify:task runs scripts/verify-task.ts",
);
check.expect(steps.includes("run: pnpm install --frozen-lockfile"), "CI installs with --frozen-lockfile");
check.expect(steps.includes("run: pnpm verify:task -- D01"), "CI runs pnpm verify:task -- D01");
check.expect(steps.includes("node-version-file: .node-version"), "CI uses the Node version from .node-version");
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
check.finish();
