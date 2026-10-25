// Storage preflight (Architektura §14.5, §15.2): before any database work the required
// directories must be real directories inside their mount root and accept a create/read/delete
// probe, and the data file system must keep the configured reserve. Nothing is created,
// repaired or re-permissioned here; a missing or wrong directory is reported, not fixed.
import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type { WorkingPaths } from "./installation-paths.js";

export type StorageRole = "data" | "backups" | "tmp" | "maintenance" | "logs";

export type PreflightResult =
  | Readonly<{ ok: true; degraded: readonly StorageRole[] }>
  | Readonly<{ ok: false; code: "STORAGE_UNWRITABLE" | "STORAGE_LOW_SPACE"; fields: readonly StorageRole[] }>;

const MIB = 1024 * 1024;
const PROBE_PREFIX = ".openlife-preflight-";

/** True when `inner` is `outer` or below it (both already resolved). */
function within(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The directory must not itself be a symlink, must resolve inside its mount root and must take
 * a new file (exclusive create, so nothing existing is overwritten), read it back and delete it.
 */
function usable(dir: string, root: string): boolean {
  try {
    if (lstatSync(dir).isSymbolicLink() || lstatSync(root).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
      return false;
    }
    if (!within(realpathSync(dir), realpathSync(root))) {
      return false;
    }
    const probe = path.join(dir, `${PROBE_PREFIX}${randomBytes(8).toString("hex")}`);
    const content = randomBytes(16).toString("hex");
    const fd = openSync(probe, "wx", 0o600);
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    try {
      return readFileSync(probe, "utf8") === content;
    } finally {
      unlinkSync(probe);
    }
  } catch {
    return false;
  }
}

export function runStoragePreflight(paths: WorkingPaths, reserveMiB: number): PreflightResult {
  const critical: ReadonlyArray<readonly [StorageRole, string, string]> = [
    ["data", path.dirname(paths.database), paths.roots.data],
    ["backups", paths.backups, paths.roots.data],
    ["tmp", paths.tmp, paths.roots.data],
    ["maintenance", paths.maintenance, paths.roots.maintenance],
  ];
  const unwritable = critical.filter(([, dir, root]) => !usable(dir, root)).map(([role]) => role);
  if (unwritable.length > 0) {
    return { ok: false, code: "STORAGE_UNWRITABLE", fields: unwritable };
  }

  const stats = statfsSync(paths.roots.data);
  if (stats.bavail * stats.bsize < reserveMiB * MIB) {
    return { ok: false, code: "STORAGE_LOW_SPACE", fields: ["data"] };
  }

  // Logs are an optional sink: their failure degrades diagnostics but never blocks the start.
  return { ok: true, degraded: usable(paths.logs, paths.roots.data) ? [] : ["logs"] };
}
