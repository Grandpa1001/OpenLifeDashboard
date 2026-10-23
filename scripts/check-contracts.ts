// pnpm check:contracts — public package contracts (Architektura §13.3, DEV D01.2).
// 1. Manifest policy: explicit exports only, source/types/runtime triples, pinned dependencies.
// 2. Every export is compiled by a tsconfig whose runtime profile is known.
// 3. Negative controls from tests/contracts must be rejected with the expected code.
// 4. The TypeScript solution builds and every export has its declaration and JS output.
// 5. Runtime-neutral and Node exports load in a bare Node process (no browser runtime needed).
// Exit code 0 only when every step passes.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { manifestCases } from "../tests/contracts/cases.ts";
import {
  checkDependencyRanges,
  checkManifest,
  readExports,
  type ManifestProblem,
} from "./support/manifest-policy.ts";
import { isFile, listWorkspaces, packageBin, readJsonObject, type Workspace } from "./support/workspaces.ts";

type RuntimeProfile = "neutral" | "node" | "browser";
type ProjectConfig = Readonly<{ file: string; profile: RuntimeProfile | undefined; include: readonly string[] }>;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// The shared configs in tooling/typescript define which globals and libs a project may use.
const PROFILE_BY_BASE_CONFIG: Readonly<Record<string, RuntimeProfile>> = {
  "tsconfig.base.json": "neutral",
  "tsconfig.node.json": "node",
  "tsconfig.browser.json": "browser",
};

const exists = (relative: string): boolean => isFile(path.join(repoRoot, relative));

function readProjectConfigs(workspaceDir: string): ProjectConfig[] {
  const absolute = path.join(repoRoot, workspaceDir);
  return readdirSync(absolute)
    .filter((name) => /^tsconfig(\.[\w-]+)?\.json$/.test(name))
    .map((name) => {
      const config = readJsonObject(path.join(absolute, name));
      const base = typeof config["extends"] === "string" ? path.basename(config["extends"]) : "";
      const include = Array.isArray(config["include"]) ? config["include"].map(String) : [];
      return { file: `${workspaceDir}/${name}`, profile: PROFILE_BY_BASE_CONFIG[base], include };
    });
}

/** The project compiling `source` (workspace-relative, e.g. "src/index.ts"), if any. */
function owningProject(configs: readonly ProjectConfig[], source: string): ProjectConfig | undefined {
  return configs.find((config) =>
    config.include.some((entry) => source === entry || source.startsWith(`${entry.replace(/\/$/, "")}/`)),
  );
}

function runNode(args: readonly string[], cwd: string): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (run.error) {
    throw run.error;
  }
  return { status: run.status, output: `${run.stdout}${run.stderr}`.trim() };
}

function report(step: string, problems: readonly string[], passedDetail: string): boolean {
  if (problems.length === 0) {
    console.log(`  ${step}: passed — ${passedDetail}`);
    return true;
  }
  console.log(`  ${step}: FAILED`);
  for (const problem of problems) {
    console.log(`    ${problem}`);
  }
  return false;
}

const formatProblem = (problem: ManifestProblem): string => `${problem.code} (${problem.where}): ${problem.detail}`;

function checkManifests(workspaces: readonly Workspace[]): boolean {
  const root = readJsonObject(path.join(repoRoot, "package.json"));
  const problems = [
    ...checkDependencyRanges(root, "package.json"),
    ...workspaces.flatMap((workspace) => checkManifest(workspace, exists)),
  ].map(formatProblem);
  if (typeof root["packageManager"] !== "string" || !/^pnpm@\d+\.\d+\.\d+$/.test(root["packageManager"])) {
    problems.push("package-manager (package.json): packageManager must pin an exact pnpm version");
  }
  const exportCount = workspaces.reduce((sum, workspace) => sum + readExports(workspace.manifest).length, 0);
  return report("manifests", problems, `${workspaces.length} workspaces, ${exportCount} exports`);
}

function checkProjects(workspaces: readonly Workspace[]): Map<string, RuntimeProfile> {
  const profiles = new Map<string, RuntimeProfile>();
  const problems: string[] = [];
  for (const workspace of workspaces) {
    const configs = readProjectConfigs(workspace.dir);
    for (const entry of readExports(workspace.manifest)) {
      const source = entry.source.slice(2);
      const project = owningProject(configs, source);
      if (!project) {
        problems.push(`source-not-built (${workspace.dir}): ${source} is not included by any tsconfig`);
      } else if (!project.profile) {
        problems.push(`unknown-runtime-profile (${project.file}): extend a config from tooling/typescript`);
      } else {
        profiles.set(`${workspace.dir}/${entry.runtime.slice(2)}`, project.profile);
      }
    }
  }
  report("projects", problems, `${profiles.size} exports mapped to a runtime profile`);
  return problems.length === 0 ? profiles : new Map();
}

function checkControls(workspaces: readonly Workspace[]): boolean {
  const bases = {
    package: workspaces.find((workspace) => workspace.dir === "packages/core"),
    app: workspaces.find((workspace) => workspace.dir === "apps/server"),
  };
  const failures: string[] = [];
  for (const control of manifestCases) {
    const base = bases[control.base];
    if (!base) {
      failures.push(`${control.id}: base workspace for "${control.base}" is missing`);
      continue;
    }
    const codes = checkManifest({ ...base, manifest: control.mutate(base.manifest) }, exists).map((p) => p.code);
    if (!codes.includes(control.expect)) {
      failures.push(`${control.id}: expected ${control.expect}, got [${codes.join(", ") || "nothing"}]`);
    }
  }
  const unbuilt = owningProject([{ file: "tsconfig.json", profile: "neutral", include: ["src/definitions.ts"] }], "src/views.ts");
  if (unbuilt) {
    failures.push("source-not-built: a source outside every include was treated as compiled");
  }
  return report("negative controls", failures, `${manifestCases.length + 1} rejected as expected`);
}

function checkBuild(workspaces: readonly Workspace[]): boolean {
  const build = runNode([packageBin(repoRoot, "typescript", "tsc"), "-b"], repoRoot);
  if (build.status !== 0) {
    return report("types", [`tsc -b exited ${build.status}:\n${build.output}`], "");
  }
  report("types", [], "tsc -b (strict) succeeded");
  const missing = workspaces.flatMap((workspace) =>
    readExports(workspace.manifest).flatMap((entry) =>
      [entry.types, entry.runtime]
        .map((file) => `${workspace.dir}/${file.slice(2)}`)
        .filter((file) => !exists(file))
        .map((file) => `export-artifact-missing: ${file}`),
    ),
  );
  return report("build artifacts", missing, "every export has .d.ts and .js output");
}

function checkRuntime(profiles: ReadonlyMap<string, RuntimeProfile>): boolean {
  const problems: string[] = [];
  const browserOnly: string[] = [];
  let loaded = 0;
  for (const [file, profile] of profiles) {
    if (profile === "browser") {
      browserOnly.push(file);
      continue;
    }
    const url = pathToFileURL(path.join(repoRoot, file)).href;
    const run = runNode(["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], repoRoot);
    if (run.status === 0) {
      loaded += 1;
    } else {
      problems.push(`runtime-import-failed (${profile}): ${file}\n${run.output}`);
    }
  }
  const passed = report("runtime", problems, `${loaded} neutral/node exports loaded in bare Node ${process.version}`);
  if (browserOnly.length > 0) {
    console.log(`  runtime (browser): not_run — ${browserOnly.join(", ")}; browser loading is verified from D02/D08`);
  }
  return passed;
}

function main(): number {
  console.log("check:contracts");
  const workspaces = listWorkspaces(repoRoot);
  const manifestsPassed = checkManifests(workspaces);
  const profiles = checkProjects(workspaces);
  const controlsPassed = checkControls(workspaces);
  const buildPassed = checkBuild(workspaces);
  // Loading needs a finished build and a complete export → profile map.
  const runtimePassed = buildPassed && profiles.size > 0 && checkRuntime(profiles);
  const passed = manifestsPassed && profiles.size > 0 && controlsPassed && buildPassed && runtimePassed;
  console.log(passed ? "check:contracts passed" : "check:contracts failed");
  return passed ? 0 : 1;
}

process.exitCode = main();
