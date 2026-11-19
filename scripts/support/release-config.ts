// The configuration of the versions of a release (DEV §9.60 D61.3): Release Please in the mode of a manifest, one version for the whole product, kept in
// the four package files that carry it (the root, the server, the updater and the web app) and in `.release-please-manifest.json`. `releaseConfigProblems`
// returns what is wrong, one sentence each; empty when the version is one value and Release Please is told to change every file that holds it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { VERSIONED_PACKAGES } from "./image-publish.ts";

export const RELEASE_CONFIG_FILE = "release-please-config.json";
export const RELEASE_MANIFEST_FILE = ".release-please-manifest.json";
const ROOT_PACKAGE = "package.json";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function read(root: string, file: string, problems: string[]): unknown {
  const full = path.join(root, file);
  if (!existsSync(full)) {
    problems.push(`${file} is missing`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(full, "utf8"));
  } catch {
    problems.push(`${file} is not JSON`);
    return undefined;
  }
}

export function releaseConfigProblems(root: string): string[] {
  const problems: string[] = [];
  const config = read(root, RELEASE_CONFIG_FILE, problems);
  const manifest = read(root, RELEASE_MANIFEST_FILE, problems);
  const versions = new Map<string, unknown>(
    VERSIONED_PACKAGES.map((file) => {
      const content = read(root, file, problems);
      return [file, isObject(content) ? content["version"] : undefined];
    }),
  );

  const rootVersion = versions.get(ROOT_PACKAGE);
  if (typeof rootVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(rootVersion)) problems.push(`${ROOT_PACKAGE} has no version x.y.z`);
  for (const [file, version] of versions) if (version !== rootVersion) problems.push(`${file} has the version ${String(version)}, the root has ${String(rootVersion)}: one version for the whole product`);
  if (!isObject(manifest) || manifest["."] !== rootVersion || Object.keys(manifest).length !== 1) problems.push(`${RELEASE_MANIFEST_FILE} must be { ".": "${String(rootVersion)}" } and nothing else`);

  if (!isObject(config)) return problems;
  const expectedSettings: Readonly<Record<string, unknown>> = {
    "release-type": "node",
    "include-component-in-tag": false,
    "include-v-in-tag": true,
    draft: true,
    "force-tag-creation": true,
    // Without it the first release of a repository with no tag is 1.0.0, whatever the manifest says (seen in the first run of the pipeline).
    "initial-version": "0.1.0",
    "bump-minor-pre-major": true,
    "changelog-path": "CHANGELOG.md",
  };
  for (const [key, value] of Object.entries(expectedSettings)) if (config[key] !== value) problems.push(`${RELEASE_CONFIG_FILE}: ${key} must be ${JSON.stringify(value)}`);
  const packages = config["packages"];
  const rootPackage = isObject(packages) ? packages["."] : undefined;
  if (!isObject(packages) || Object.keys(packages).length !== 1 || !isObject(rootPackage)) {
    problems.push(`${RELEASE_CONFIG_FILE}: packages must have the root "." and nothing else (one version for the product)`);
    return problems;
  }
  const extras = Array.isArray(rootPackage["extra-files"]) ? rootPackage["extra-files"] : [];
  const listed = extras.flatMap((entry) => (isObject(entry) && entry["type"] === "json" && entry["jsonpath"] === "$.version" && typeof entry["path"] === "string" ? [entry["path"]] : []));
  const needed: readonly string[] = VERSIONED_PACKAGES.filter((file) => file !== ROOT_PACKAGE);
  for (const file of needed) if (!listed.includes(file)) problems.push(`${RELEASE_CONFIG_FILE}: ${file} must be in extra-files with the jsonpath $.version, or the release leaves it at the old version`);
  for (const file of listed) if (!needed.includes(file)) problems.push(`${RELEASE_CONFIG_FILE}: extra-files lists ${file}, which is not a file that carries the version`);
  return problems;
}
