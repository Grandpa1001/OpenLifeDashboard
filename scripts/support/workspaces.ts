import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type JsonObject = Readonly<Record<string, unknown>>;

export type Workspace = Readonly<{
  /** Repository-relative directory with forward slashes, e.g. "packages/core". */
  dir: string;
  kind: "app" | "package";
  manifest: JsonObject;
}>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonObject(file: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isJsonObject(value)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return value;
}

/**
 * Reads the `packages:` globs of pnpm-workspace.yaml. Only the `<dir>/*` form used by this
 * repository is supported; anything else fails loudly instead of being skipped.
 */
export function readWorkspacePatterns(repoRoot: string): string[] {
  const lines = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
  const start = lines.indexOf("packages:");
  if (start < 0) {
    throw new Error("pnpm-workspace.yaml has no top-level packages: list");
  }
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (!item?.[1]) {
      break;
    }
    if (!/^[\w-]+\/\*$/.test(item[1])) {
      throw new Error(`Unsupported workspace pattern "${item[1]}"; expected "<dir>/*"`);
    }
    patterns.push(item[1]);
  }
  if (patterns.length === 0) {
    throw new Error("pnpm-workspace.yaml packages: list is empty");
  }
  return patterns;
}

export function listWorkspaces(repoRoot: string): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const pattern of readWorkspacePatterns(repoRoot)) {
    const parent = pattern.slice(0, -2);
    for (const name of readdirSync(path.join(repoRoot, parent)).sort()) {
      const manifestFile = path.join(repoRoot, parent, name, "package.json");
      if (!isFile(manifestFile)) {
        continue;
      }
      workspaces.push({
        dir: `${parent}/${name}`,
        kind: parent === "apps" ? "app" : "package",
        manifest: readJsonObject(manifestFile),
      });
    }
  }
  return workspaces;
}

/** Repository-relative paths of all files below `dir`, with forward slashes, sorted. */
export function listFiles(repoRoot: string, dir: string): string[] {
  const absolute = path.join(repoRoot, dir);
  return readdirSync(absolute, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => isFile(path.join(absolute, entry)))
    .map((entry) => `${dir}/${entry.split(path.sep).join("/")}`)
    .sort();
}

export function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of an executable script declared in an installed package's `bin` field. */
export function packageBin(repoRoot: string, packageName: string, binName: string): string {
  const manifestFile = path.join(repoRoot, "node_modules", packageName, "package.json");
  const bin = readJsonObject(manifestFile)["bin"];
  const relative = typeof bin === "string" ? bin : isJsonObject(bin) ? bin[binName] : undefined;
  if (typeof relative !== "string") {
    throw new Error(`${packageName} does not declare the "${binName}" executable`);
  }
  return path.join(path.dirname(manifestFile), relative);
}
