// pnpm verify:task -- <ID> — runs the checks mapped to a DEV task, work order or gate
// (DEV §8.1 pt 5, §8.3) and writes .artifacts/<run-id>/verification.json plus summary.txt.
// Results: passed | failed | blocked | not_run. Exit 0 only when the task passed;
// 1 when anything failed or is blocked; 2 for usage errors and unknown IDs.
//
// Options (used by the runner's own tests with an isolated map):
//   --root <dir>       directory checks run in and `requires` resolve against (default: repo)
//   --tasks <file>     module exporting `verificationTasks` (default: tooling/verification-tasks.ts)
//   --artifacts <dir>  where run directories are created (default: <root>/.artifacts)
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BLOCKED_EXIT_CODE,
  EVIDENCE_DIR_ENV,
  type CheckDefinition,
  type TaskDefinition,
} from "../tooling/verification-tasks.ts";
import { toolInvocation } from "./support/toolchain.ts";
import { isFile, isJsonObject, listFiles } from "./support/workspaces.ts";

type Status = "passed" | "failed" | "blocked" | "not_run";
type ReadyTask = Extract<TaskDefinition, { ready: true }>;

type CheckResult = Readonly<{
  id: string;
  criteria: readonly string[];
  description: string;
  command: readonly string[];
  status: Status;
  exitCode: number | null;
  durationMs: number;
  reason?: string;
  log?: string;
  /** Files the check saved under evidence/<check id>/, relative to the run directory. */
  evidence?: readonly string[];
}>;

class UsageError extends Error {}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const BASELINE_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
// Worst first: a single failed check fails the criterion, a missing one blocks it.
const SEVERITY: readonly Status[] = ["failed", "blocked", "not_run", "passed"];

function worst(statuses: readonly Status[]): Status {
  return SEVERITY.find((status) => statuses.includes(status)) ?? "not_run";
}

function parseArgs(argv: readonly string[]): { id: string; root: string; tasks: string; artifacts: string } {
  const options = new Map<string, string>();
  const positional: string[] = [];
  const args = argv.filter((arg) => arg !== "--");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["--root", "--tasks", "--artifacts"].includes(arg)) {
      const value = args[index + 1];
      if (!value) {
        throw new UsageError(`${arg} needs a value`);
      }
      options.set(arg, path.resolve(value));
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`Unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1 || !positional[0]) {
    throw new UsageError("Usage: pnpm verify:task -- <task, work order or gate ID>, e.g. D01 or D01.2");
  }
  const root = options.get("--root") ?? repoRoot;
  return {
    id: positional[0],
    root,
    tasks: options.get("--tasks") ?? path.join(repoRoot, "tooling/verification-tasks.ts"),
    artifacts: options.get("--artifacts") ?? path.join(root, ".artifacts"),
  };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

/** The map is loaded at runtime, so its shape is validated instead of trusted. */
function validateTasks(value: unknown): Map<string, TaskDefinition> {
  if (!Array.isArray(value)) {
    throw new UsageError("verificationTasks must be an array");
  }
  const tasks = new Map<string, TaskDefinition>();
  for (const task of value) {
    if (!isJsonObject(task) || typeof task["id"] !== "string" || typeof task["ready"] !== "boolean") {
      throw new UsageError(`Malformed task entry ${JSON.stringify(task)}`);
    }
    const id = task["id"];
    if (tasks.has(id)) {
      throw new UsageError(`Duplicate task ${id}`);
    }
    if (task["ready"]) {
      const { criteria, checks, steps, title } = task;
      if (typeof title !== "string" || !isStringArray(criteria) || !Array.isArray(checks)) {
        throw new UsageError(`${id}: ready tasks need title, criteria and checks`);
      }
      if (steps !== undefined && !isStringArray(steps)) {
        throw new UsageError(`${id}: steps must be task IDs`);
      }
      for (const check of checks) {
        const checkCriteria = isJsonObject(check) ? check["criteria"] : undefined;
        const valid =
          isJsonObject(check) &&
          typeof check["id"] === "string" &&
          typeof check["description"] === "string" &&
          isStringArray(checkCriteria) &&
          isStringArray(check["command"]) &&
          Array.isArray(check["requires"]) &&
          check["requires"].every((file) => typeof file === "string") &&
          (check["timeoutMs"] === undefined || (typeof check["timeoutMs"] === "number" && check["timeoutMs"] > 0));
        if (!valid || !isStringArray(checkCriteria)) {
          throw new UsageError(`${id}: malformed check ${JSON.stringify(check)}`);
        }
        const foreign = checkCriteria.filter((criterion) => !criteria.includes(criterion));
        if (foreign.length > 0) {
          throw new UsageError(`${id}: check ${String(check["id"])} covers undeclared criteria ${foreign.join(", ")}`);
        }
      }
    }
    tasks.set(id, task as TaskDefinition);
  }
  return tasks;
}

async function loadTasks(file: string): Promise<Map<string, TaskDefinition>> {
  if (!isFile(file)) {
    throw new UsageError(`Task map ${file} does not exist`);
  }
  const loaded: unknown = await import(pathToFileURL(file).href);
  return validateTasks(isJsonObject(loaded) ? loaded["verificationTasks"] : undefined);
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

function git(root: string, args: readonly string[]): Buffer | null {
  const run = spawnSync("git", args, { cwd: root, maxBuffer: MAX_LOG_BYTES });
  return run.status === 0 && !run.error ? run.stdout : null;
}

/** Code version and the exact state of uncommitted work the evidence refers to (DEV §9.3). */
function describeCode(root: string): Record<string, unknown> {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head) {
    return { git: false };
  }
  const diff = git(root, ["diff", "HEAD", "--binary"]) ?? Buffer.alloc(0);
  const untracked = (git(root, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? Buffer.alloc(0))
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  return {
    git: true,
    commit: head.toString("utf8").trim(),
    dirty: diff.length > 0 || untracked.length > 0,
    trackedDiffSha256: sha256(diff),
    untracked: untracked.map((file) => ({ path: file, sha256: hashFile(path.join(root, file)) })),
  };
}

function hashFile(file: string): string | null {
  return isFile(file) ? sha256(readFileSync(file)) : null;
}

function describeEnvironment(): Record<string, unknown> {
  const agent = process.env["npm_config_user_agent"] ?? "";
  return {
    node: process.version,
    pnpm: /\bpnpm\/(\S+)/.exec(agent)?.[1] ?? null,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    ci: process.env["CI"] === "true",
  };
}

function runCheck(check: CheckDefinition, root: string, runDir: string): CheckResult {
  const base = {
    id: check.id,
    criteria: check.criteria,
    description: check.description,
    command: check.command,
  };
  const missing = check.requires.filter((file) => !isFile(path.join(root, file)));
  if (missing.length > 0) {
    return { ...base, status: "blocked", exitCode: null, durationMs: 0, reason: `missing ${missing.join(", ")}` };
  }
  const evidenceDir = path.join(runDir, "evidence", check.id);
  mkdirSync(evidenceDir, { recursive: true });
  const invocation = toolInvocation(check.command);
  const started = performance.now();
  const run = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_LOG_BYTES,
    timeout: check.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: { ...process.env, [EVIDENCE_DIR_ENV]: evidenceDir },
  });
  const durationMs = Math.round(performance.now() - started);
  const log = `checks/${check.id}.log`;
  writeFileSync(path.join(runDir, log), `$ ${check.command.join(" ")}\n${run.stdout ?? ""}${run.stderr ?? ""}`);
  const evidence = listFiles(runDir, `evidence/${check.id}`);
  const executed = { ...base, durationMs, log, ...(evidence.length > 0 ? { evidence } : {}) };

  const errorCode = run.error && "code" in run.error ? String(run.error.code) : undefined;
  if (errorCode === "ENOENT") {
    return { ...executed, status: "blocked", exitCode: null, reason: `${invocation.command} not found` };
  }
  if (errorCode === "ETIMEDOUT") {
    return { ...executed, status: "failed", exitCode: null, reason: "timed out" };
  }
  if (run.error) {
    return { ...executed, status: "failed", exitCode: null, reason: run.error.message };
  }
  if (run.status === BLOCKED_EXIT_CODE) {
    return { ...executed, status: "blocked", exitCode: run.status, reason: "precondition unavailable (see log)" };
  }
  return { ...executed, status: run.status === 0 ? "passed" : "failed", exitCode: run.status };
}

/** Checks and criteria of a task including its work orders; not-ready steps block it. */
function expandTask(task: ReadyTask, tasks: ReadonlyMap<string, TaskDefinition>) {
  const checks = new Map<string, CheckDefinition>();
  const criteria: string[] = [];
  const blockers: string[] = [];
  for (const stepId of task.steps ?? []) {
    const step = tasks.get(stepId);
    if (!step?.ready) {
      blockers.push(`${stepId} is ${step ? "not ready for verification" : "missing from the task map"}`);
      continue;
    }
    criteria.push(...step.criteria);
    for (const check of step.checks) {
      checks.set(check.id, check);
    }
  }
  criteria.push(...task.criteria);
  for (const check of task.checks) {
    checks.set(check.id, check);
  }
  return { checks: [...checks.values()], criteria, blockers };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const tasks = await loadTasks(options.tasks);
  const task = tasks.get(options.id);
  if (!task) {
    throw new UsageError(`Unknown task ${options.id}; IDs come from DEV §3/§9 (e.g. D01, D01.2, G0)`);
  }

  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${options.id}-${randomBytes(3).toString("hex")}`;
  const runDir = path.join(options.artifacts, runId);
  const logDir = path.join(runDir, "checks");
  mkdirSync(logDir, { recursive: true });

  const expanded = task.ready ? expandTask(task, tasks) : undefined;
  const blockers = expanded?.blockers ?? [`${task.id} is not ready for verification; define its checks first (DEV §9)`];
  const results = (expanded?.checks ?? []).map((check) => {
    const result = runCheck(check, options.root, runDir);
    console.log(`  ${result.status.padEnd(7)} ${result.id}${result.reason ? ` — ${result.reason}` : ""}`);
    return result;
  });
  const criteria = (expanded?.criteria ?? []).map((id) => {
    const covering = results.filter((result) => result.criteria.includes(id));
    return { id, status: covering.length > 0 ? worst(covering.map((result) => result.status)) : "blocked", checks: covering.map((r) => r.id) };
  });
  const result: Status =
    blockers.length > 0 ? worst(["blocked", ...criteria.map((c) => c.status)]) : worst(criteria.map((c) => c.status));

  const inputFiles = [
    ...new Set([...BASELINE_INPUTS, ...(expanded?.checks ?? []).flatMap((check) => check.requires)]),
  ].sort();
  const report = {
    schemaVersion: 1,
    runId,
    task: task.id,
    title: task.ready ? task.title : null,
    result,
    blockers,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    code: describeCode(options.root),
    environment: describeEnvironment(),
    taskMap: { path: path.relative(options.root, options.tasks), sha256: hashFile(options.tasks) },
    inputs: inputFiles.map((file) => ({ path: file, sha256: hashFile(path.join(options.root, file)) })),
    criteria,
    checks: results,
  };
  writeFileSync(path.join(runDir, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);

  const summary = [
    `verify:task ${task.id} — ${result}`,
    ...blockers.map((blocker) => `  blocked: ${blocker}`),
    ...criteria.map((criterion) => `  ${criterion.status.padEnd(7)} ${criterion.id} (${criterion.checks.join(", ") || "no check"})`),
    `report: ${path.relative(process.cwd(), path.join(runDir, "verification.json")) || runDir}`,
  ].join("\n");
  writeFileSync(path.join(runDir, "summary.txt"), `${summary}\n`);
  console.log(summary);
  return result === "passed" ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`verify:task: ${error.message}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
