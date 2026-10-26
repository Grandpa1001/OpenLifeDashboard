// Temporary folders of test helpers (DEV §8.3: every test works in its own folder, and leaves
// none behind). A vitest worker does not end with the process "exit" event, so the folders are
// removed after each test file by tests/support/vitest-setup.ts; plain scripts keep the exit hook.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const created: string[] = [];
const shared = new Map<string, string>();

/** A new folder under the OS temp dir, removed with the others of this process. */
export function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** One folder per prefix for a helper's many small files, created again after a removal. */
export function sharedScratchDir(prefix: string): string {
  const existing = shared.get(prefix);
  if (existing) return existing;
  const dir = scratchDir(prefix);
  shared.set(prefix, dir);
  return dir;
}

export function removeScratchDirs(): void {
  shared.clear();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

process.once("exit", removeScratchDirs);
