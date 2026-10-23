// Package manifest rules for the product workspace (Architektura §13.3: explicit exports).
// Pure functions: the file system is reached only through the injected `fileExists`.
import { isJsonObject, type JsonObject, type Workspace } from "./workspaces.ts";

export type ManifestProblemCode =
  | "name-mismatch"
  | "not-private"
  | "not-esm"
  | "legacy-entry-field"
  | "library-without-exports"
  | "app-with-exports"
  | "wildcard-export"
  | "export-conditions"
  | "export-paths"
  | "export-source-missing"
  | "dependency-range";

export type ManifestProblem = Readonly<{ code: ManifestProblemCode; where: string; detail: string }>;

export type PackageExport = Readonly<{ subpath: string; source: string; types: string; runtime: string }>;

/** Condition order matters: bundlers and TypeScript pick the first matching key. */
export const EXPORT_CONDITIONS = ["@openlife/source", "types", "default"] as const;
const LEGACY_ENTRY_FIELDS = ["main", "module", "types", "typings", "browser"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SOURCE_PATH = /^\.\/src\/(.+)\.tsx?$/;

/** Every dependency is pinned: exact version, the shared catalog, or the local workspace. */
export function checkDependencyRanges(manifest: JsonObject, where: string): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (dependencies === undefined) {
      continue;
    }
    if (!isJsonObject(dependencies)) {
      problems.push({ code: "dependency-range", where, detail: `${field} must be an object` });
      continue;
    }
    for (const [name, range] of Object.entries(dependencies)) {
      const allowed = name.startsWith("@openlife/")
        ? range === "workspace:*"
        : range === "catalog:" || (typeof range === "string" && EXACT_VERSION.test(range));
      if (!allowed) {
        problems.push({ code: "dependency-range", where, detail: `${field}.${name} = ${JSON.stringify(range)}` });
      }
    }
  }
  return problems;
}

export function readExports(manifest: JsonObject): PackageExport[] {
  const exportsField = manifest["exports"];
  if (!isJsonObject(exportsField)) {
    return [];
  }
  return Object.entries(exportsField).flatMap(([subpath, target]) => {
    if (!isJsonObject(target)) {
      return [];
    }
    const [source, types, runtime] = EXPORT_CONDITIONS.map((condition) => target[condition]);
    return typeof source === "string" && typeof types === "string" && typeof runtime === "string"
      ? [{ subpath, source, types, runtime }]
      : [];
  });
}

export function checkManifest(workspace: Workspace, fileExists: (relative: string) => boolean): ManifestProblem[] {
  const { manifest, dir } = workspace;
  const problems: ManifestProblem[] = [];
  const add = (code: ManifestProblemCode, detail: string): void => {
    problems.push({ code, where: dir, detail });
  };

  const expectedName = `@openlife/${dir.split("/").at(-1)}`;
  if (manifest["name"] !== expectedName) {
    add("name-mismatch", `name must be ${expectedName}, got ${JSON.stringify(manifest["name"])}`);
  }
  if (manifest["private"] !== true) {
    add("not-private", "private must be true until publishing is designed");
  }
  if (manifest["type"] !== "module") {
    add("not-esm", 'type must be "module"');
  }
  for (const field of LEGACY_ENTRY_FIELDS) {
    if (field in manifest) {
      add("legacy-entry-field", `"${field}" bypasses exports; declare entrypoints in exports only`);
    }
  }
  problems.push(...checkDependencyRanges(manifest, dir));

  const exportsField = manifest["exports"];
  if (workspace.kind === "app") {
    if (exportsField !== undefined) {
      add("app-with-exports", "applications are not importable libraries");
    }
    return problems;
  }
  if (!isJsonObject(exportsField) || Object.keys(exportsField).length === 0) {
    add("library-without-exports", "packages must declare explicit exports");
    return problems;
  }

  for (const [subpath, target] of Object.entries(exportsField)) {
    if (subpath.includes("*") || JSON.stringify(target).includes("*")) {
      add("wildcard-export", `${subpath} exposes a pattern instead of a named entrypoint`);
      continue;
    }
    if (subpath !== "." && !/^\.\/[\w-]+(\/[\w-]+)*$/.test(subpath)) {
      add("export-paths", `${subpath} is not a plain subpath`);
    }
    if (!isJsonObject(target) || JSON.stringify(Object.keys(target)) !== JSON.stringify(EXPORT_CONDITIONS)) {
      add("export-conditions", `${subpath} must map exactly ${EXPORT_CONDITIONS.join(", ")} in this order`);
      continue;
    }
    const [source, types, runtime] = EXPORT_CONDITIONS.map((condition) => target[condition]);
    const stem = typeof source === "string" ? SOURCE_PATH.exec(source)?.[1] : undefined;
    if (!stem || types !== `./dist/${stem}.d.ts` || runtime !== `./dist/${stem}.js`) {
      add("export-paths", `${subpath} must point ./src/<name>.ts to ./dist/<name>.d.ts and ./dist/<name>.js`);
      continue;
    }
    if (typeof source === "string" && !fileExists(`${dir}/${source.slice(2)}`)) {
      add("export-source-missing", `${subpath} source ${source} does not exist`);
    }
  }
  return problems;
}
