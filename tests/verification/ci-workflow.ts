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
check.expect(steps.includes("timeout 300 pnpm install --frozen-lockfile && exit 0"), "CI installs with --frozen-lockfile, an attempt that stalls is cut and repeated");
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

// The two tiers (DEV §8): the fast tier runs on every push, the full tier — Docker, the images, the
// gates — only when it is asked for, and no gate is decided on a partial set of reports.
type Step = { name?: string; run?: string; if?: string };
type Job = { needs?: string | string[]; if?: string; steps?: Step[] };
const parsed = parseDocument(workflow).toJS() as { on?: Record<string, unknown>; concurrency?: Record<string, unknown>; jobs?: Record<string, Job> };
const jobs = parsed.jobs ?? {};
const tasksOf = (job: string): string[] => (jobs[job]?.steps ?? []).flatMap((step) => /^pnpm verify:task -- (\S+)$/.exec(step.run ?? "")?.slice(1) ?? []);
const SLOW = ["D02.1", "D02.2", "D02.3", "D03", "D04", "D05", "D06", "D07", "D08", "D19.3", "D19", "G0"];
const GATES = ["D13.3", "D13", "D14", "D15", "D16", "D17", "D18", "D19", "G0"];
const fastTasks = [...tasksOf("fast-core"), ...tasksOf("fast-browser")];
check.expect(fastTasks.length > 0 && SLOW.every((id) => !fastTasks.includes(id)), "the fast tier runs no Docker, image or G0 task", fastTasks.join(", "));
check.expect(GATES.every((id) => !fastTasks.includes(id)), "the fast tier runs no gate or handover: they join the reports of the full tier", fastTasks.join(", "));
check.expect(["D01", "D09", "D10", "D11", "D12", "D13.1", "D13.2", "D14.1", "D14.2", "D14.3", "D15.1", "D15.2", "D15.3", "D16.1", "D16.2", "D16.3", "D17.1", "D17.2", "D17.3", "D17.4", "D18.1", "D18.2", "D18.3", "D19.1", "D19.2", "D20.1"].every((id) => fastTasks.includes(id)), "the fast tier runs the tasks of the code that changes from step to step", fastTasks.join(", "));
const allTasks = Object.keys(jobs).flatMap(tasksOf);
check.expect(allTasks.filter((id) => !fastTasks.includes(id)).length > 0 && GATES.every((id) => allTasks.includes(id)), "the full tier runs the rest and the gates");
check.expect(
  jobs["full"]?.needs === "changes" && jobs["full"]?.if === "${{ needs.changes.outputs.full == 'true' }}",
  "the full tier waits for the decision of the changes job and runs only when it says so",
);
// The full tier is several jobs side by side, one per topic; each is decided by the same changes job
// and uploads a report artifact of its own, so a long task list never meets one job's time limit.
const fullJobs = Object.keys(jobs).filter((job) => job === "full" || job.startsWith("full-"));
check.expect(
  fullJobs.length > 1 && fullJobs.every((job) => jobs[job]?.needs === "changes" && jobs[job]?.if === "${{ needs.changes.outputs.full == 'true' }}"),
  `every job of the full tier waits for the changes job and runs only when it says so (${fullJobs.join(", ")})`,
);
const topicTasks = fullJobs.flatMap(tasksOf);
check.expect(new Set(topicTasks).size === topicTasks.length, "no task is run by two jobs of the full tier");
const uploadNames = fullJobs.map((job) => workflow.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[a-z0-9-]+:\n/)[0]?.match(/name: (verification-[a-z-]+)\n/)?.[1]);
check.expect(uploadNames.every(Boolean) && new Set(uploadNames).size === fullJobs.length, "each job of the full tier uploads its own report artifact", uploadNames.join(", "));
const needs = (job: string): string[] => [jobs[job]?.needs ?? []].flat();
check.expect(needs("image").includes("full") && needs("g0").includes("full") && needs("g0").includes("image"), "the images and G0 hang on the full tier");
check.expect((jobs["g0"]?.if ?? "").includes("needs.full.result != 'skipped'"), "G0 does not run when the full tier was skipped (never on a partial set)");
check.expect(Object.keys(parsed.on ?? {}).sort().join() === ["pull_request", "push", "schedule", "workflow_dispatch"].sort().join(), "CI runs on pushes, pull requests, nightly and by hand");
check.expect(workflow.includes("[full]") && workflow.includes("COMMIT_MESSAGE"), "a commit message with [full] asks for the full tier");
check.expect(String(parsed.concurrency?.["cancel-in-progress"] ?? "").includes("pull_request"), "only a pull request cancels its older run: every commit of main gets its result");
check.finish();
