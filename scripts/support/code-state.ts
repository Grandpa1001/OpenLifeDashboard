// The code a verification report refers to (DEV §9.3): the commit and the exact state of
// uncommitted work. Shared by the runner, which records it, and by the gates, which accept only
// reports of the code they are checking.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isFile } from "./workspaces.ts";

const MAX_LOG_BYTES = 64 * 1024 * 1024;

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

function git(root: string, args: readonly string[]): Buffer | null {
  const run = spawnSync("git", args, { cwd: root, maxBuffer: MAX_LOG_BYTES });
  return run.status === 0 && !run.error ? run.stdout : null;
}

/** Code version and the exact state of uncommitted work the evidence refers to (DEV §9.3). */
export function describeCode(root: string): Record<string, unknown> {
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

export function hashFile(file: string): string | null {
  return isFile(file) ? sha256(readFileSync(file)) : null;
}

