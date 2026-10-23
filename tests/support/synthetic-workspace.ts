import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listFiles, listWorkspaces } from "../../scripts/support/workspaces.ts";

export type SyntheticWorkspace = Readonly<{
  /** Repository-relative path → content; replaces or adds to the baseline. */
  files: Readonly<Record<string, string>>;
  /** Third-party package names stubbed under node_modules, e.g. "better-sqlite3". */
  externalModules?: readonly string[];
}>;

const EMPTY_MODULE = "export {};\n";

/**
 * Creates a throw-away copy of the repository's workspace layout in the OS temp directory:
 * the real package manifests, an empty module for every real source file, workspace links
 * under node_modules and the repository lint config. Synthetic violations therefore never
 * touch the repository or its runtime. The caller removes the directory with `dispose`.
 */
export function materializeWorkspace(repoRoot: string, spec: SyntheticWorkspace): string {
  // Real path: on macOS the temp dir is a symlink and tools report resolved file paths.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "openlife-synthetic-")));
  const write = (relative: string, content: string): void => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  for (const workspace of listWorkspaces(repoRoot)) {
    write(`${workspace.dir}/package.json`, `${JSON.stringify(workspace.manifest, null, 2)}\n`);
    for (const file of listFiles(repoRoot, `${workspace.dir}/src`)) {
      write(file, EMPTY_MODULE);
    }
    const name = workspace.manifest["name"];
    if (typeof name !== "string") {
      throw new Error(`${workspace.dir}/package.json has no name`);
    }
    const link = path.join(root, "node_modules", name);
    mkdirSync(path.dirname(link), { recursive: true });
    // "junction" keeps directory links working on Windows without elevated rights.
    symlinkSync(path.join(root, workspace.dir), link, "junction");
  }

  for (const moduleName of spec.externalModules ?? []) {
    write(
      `node_modules/${moduleName}/package.json`,
      `${JSON.stringify({ name: moduleName, version: "0.0.0", main: "index.js" })}\n`,
    );
    write(`node_modules/${moduleName}/index.js`, "module.exports = {};\n");
  }

  const lintConfig = pathToFileURL(path.join(repoRoot, "tooling/eslint/config.js")).href;
  write("eslint.config.mjs", `export { default } from ${JSON.stringify(lintConfig)};\n`);

  for (const [file, content] of Object.entries(spec.files)) {
    write(file, content);
  }
  return root;
}

export function dispose(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
