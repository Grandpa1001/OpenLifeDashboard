// pnpm check:architecture — import boundaries ARCH-01…05 (Architektura §13.3, DEV D01.2).
// 1. Checks the repository with dependency-cruiser and the architecture lint rules.
// 2. Runs every synthetic case from tests/architecture: the allowed graph must stay clean and
//    each forbidden graph must be rejected by the expected rule at the expected file.
// Exit code 0 only when the repository is clean and every control behaves as expected.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { architectureCases, type ArchitectureCase, type ArchitectureTool } from "../tests/architecture/cases.ts";
import { dispose, materializeWorkspace } from "../tests/support/synthetic-workspace.ts";
import { isJsonObject, packageBin } from "./support/workspaces.ts";

type Finding = Readonly<{ tool: ArchitectureTool; rule: string; from: string; to: string }>;
type ToolRun = Readonly<{ findings: Finding[]; scannedFiles: number }>;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SCANNED_ROOTS = ["apps", "packages"];
const DEPCRUISE_CONFIG = path.join(repoRoot, "tooling/dependency-cruiser/config.cjs");
// ESLint appends custom messages to some built-in texts, so the tag may follow other words.
const ARCH_MESSAGE = /\[((?:ARCH-\d{2}|boundary)-[\w-]+)\]/;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;

function runJsonTool(executable: string, args: readonly string[], cwd: string): unknown {
  const run = spawnSync(process.execPath, [executable, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_TOOL_OUTPUT_BYTES,
  });
  if (run.error) {
    throw run.error;
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`${path.basename(executable)} exited ${run.status} without a JSON report:\n${run.stderr}`);
  }
}

function cruiseGraph(cwd: string): ToolRun {
  const report = runJsonTool(
    packageBin(repoRoot, "dependency-cruiser", "depcruise"),
    ["--config", DEPCRUISE_CONFIG, "--output-type", "json", ...SCANNED_ROOTS],
    cwd,
  );
  const summary = isJsonObject(report) ? report["summary"] : undefined;
  const violations = isJsonObject(summary) ? summary["violations"] : undefined;
  const modules = isJsonObject(report) ? report["modules"] : undefined;
  if (!Array.isArray(violations) || !Array.isArray(modules)) {
    throw new Error("dependency-cruiser report has no summary.violations or modules");
  }
  const findings = violations.map((entry: unknown): Finding => {
    const rule = isJsonObject(entry) && isJsonObject(entry["rule"]) ? entry["rule"]["name"] : undefined;
    const from = isJsonObject(entry) ? entry["from"] : undefined;
    const to = isJsonObject(entry) ? entry["to"] : undefined;
    return { tool: "dependency-cruiser", rule: String(rule), from: String(from), to: String(to) };
  });
  const scannedFiles = modules.filter(
    (module: unknown) => isJsonObject(module) && /^(apps|packages)\//.test(String(module["source"])),
  ).length;
  return { findings, scannedFiles };
}

function lintArchitecture(cwd: string): ToolRun {
  // Uses the eslint.config.* found from cwd: the repository config or the synthetic copy.
  const report = runJsonTool(
    packageBin(repoRoot, "eslint", "eslint"),
    ["--format", "json", "--no-warn-ignored", ...SCANNED_ROOTS],
    cwd,
  );
  if (!Array.isArray(report)) {
    throw new Error("ESLint report is not an array");
  }
  const findings: Finding[] = [];
  for (const result of report) {
    if (!isJsonObject(result) || !Array.isArray(result["messages"])) {
      continue;
    }
    const from = path.relative(cwd, String(result["filePath"])).split(path.sep).join("/");
    for (const message of result["messages"]) {
      if (!isJsonObject(message)) {
        continue;
      }
      const text = String(message["message"]);
      const architectureRule = ARCH_MESSAGE.exec(text)?.[1];
      // Only architecture rules and fatal parse errors belong to this check; style is `pnpm lint`.
      if (architectureRule || message["fatal"] === true) {
        findings.push({ tool: "eslint", rule: architectureRule ?? "eslint-parse-error", from, to: text });
      }
    }
  }
  return { findings, scannedFiles: report.length };
}

function describe(finding: Finding): string {
  return `${finding.rule}: ${finding.from} → ${finding.to} (${finding.tool})`;
}

function runControl(control: ArchitectureCase): { passed: boolean; detail: string } {
  const root = materializeWorkspace(repoRoot, control.workspace);
  try {
    const { expect } = control;
    if (expect.kind === "clean") {
      const findings = [...cruiseGraph(root).findings, ...lintArchitecture(root).findings];
      return findings.length === 0
        ? { passed: true, detail: "no findings" }
        : { passed: false, detail: `unexpected findings:\n      ${findings.map(describe).join("\n      ")}` };
    }
    const run = expect.tool === "dependency-cruiser" ? cruiseGraph(root) : lintArchitecture(root);
    const hit = run.findings.find((finding) => finding.rule === expect.rule && finding.from.startsWith(expect.from));
    if (hit) {
      return { passed: true, detail: `rejected by ${hit.rule} at ${hit.from}` };
    }
    const seen = run.findings.length > 0 ? run.findings.map(describe).join("\n      ") : "nothing";
    return { passed: false, detail: `expected ${expect.rule} at ${expect.from}, saw:\n      ${seen}` };
  } finally {
    dispose(root);
  }
}

function main(): number {
  let failed = false;
  console.log("check:architecture");

  const graph = cruiseGraph(repoRoot);
  const lint = lintArchitecture(repoRoot);
  const repositoryFindings = [...graph.findings, ...lint.findings];
  if (graph.scannedFiles === 0 || lint.scannedFiles === 0) {
    failed = true;
    console.log("  repository: FAILED — no product source files were scanned");
  } else if (repositoryFindings.length > 0) {
    failed = true;
    console.log(`  repository: FAILED — ${repositoryFindings.length} violation(s)`);
    for (const finding of repositoryFindings) {
      console.log(`    ${describe(finding)}`);
    }
  } else {
    console.log(`  repository: passed — ${graph.scannedFiles} modules cruised, ${lint.scannedFiles} files linted`);
  }

  for (const control of architectureCases) {
    const result = runControl(control);
    failed ||= !result.passed;
    console.log(`  control ${control.id}: ${result.passed ? "passed" : "FAILED"} — ${result.detail}`);
  }

  console.log(failed ? "check:architecture failed" : "check:architecture passed");
  return failed ? 1 : 0;
}

process.exitCode = main();
