import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmInvocation, type Invocation } from "../../scripts/support/toolchain.ts";
import { isFile } from "../../scripts/support/workspaces.ts";
import { blockCheck } from "./check-report.ts";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const COPY_PREFIX = "openlife-copy-";

export type RunResult = Readonly<{ status: number | null; output: string }>;

/**
 * A throw-away checkout: every file git would commit (tracked plus untracked, not ignored),
 * copied to the OS temp dir without node_modules, build output, .git or local artifacts.
 */
export function copyRepository(): string {
  const listing = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (listing.error || listing.status !== 0) {
    blockCheck(`a git checkout is required to copy the repository (${listing.error?.message ?? listing.stderr.trim()})`);
  }
  const copy = realpathSync(mkdtempSync(path.join(os.tmpdir(), COPY_PREFIX)));
  for (const file of listing.stdout.split("\0").filter(Boolean)) {
    const source = path.join(repoRoot, file);
    // Tracked files deleted in the working tree are still listed; the copy mirrors the tree.
    if (isFile(source)) {
      cpSync(source, path.join(copy, file));
    }
  }
  return copy;
}

export function removeCopy(copy: string): void {
  rmSync(copy, { recursive: true, force: true });
}

export function run(invocation: Invocation, cwd: string): RunResult {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

export const runPnpm = (args: readonly string[], cwd: string): RunResult => run(pnpmInvocation(args), cwd);

export const runNode = (args: readonly string[], cwd: string): RunResult =>
  run({ command: process.execPath, args }, cwd);

/** Number of synthetic workspaces currently left in the OS temp dir. */
export function countTempDirs(prefix: string): number {
  return readdirSync(realpathSync(os.tmpdir())).filter((name) => name.startsWith(prefix)).length;
}
