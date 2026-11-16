// The file the check of the releases remembers in (Architektura §11.1; D53.2): `data/update-check.json`, written whole
// through a temporary file and a rename so a crash leaves the old one or the new one, read tolerantly (a file that is
// missing, too large, not JSON, not of this shape, or of another repository is no cache and is made again by the next
// check). It is not in the database and not in the backups: nothing in it cannot be asked for again.
import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { UPDATE_CHECK_CACHE_MAX_BYTES, UPDATE_CHECK_CACHE_FILE, updateCheckCacheSchema, type UpdateCheckCache } from "@openlife/contracts/updates/check-cache";
import { syncDirectory, writeNewFileDurably } from "../filesystem/durable-files.js";

export type CheckCacheFile = Readonly<{
  read: () => UpdateCheckCache | null;
  write: (cache: UpdateCheckCache) => void;
}>;

export function openCheckCache(dataDir: string, repository: string): CheckCacheFile {
  const file = path.join(dataDir, UPDATE_CHECK_CACHE_FILE);
  const temporary = `${file}.tmp`;
  return {
    read: () => {
      try {
        if (!existsSync(file) || lstatSync(file).isSymbolicLink() || lstatSync(file).size > UPDATE_CHECK_CACHE_MAX_BYTES) return null;
        const parsed = updateCheckCacheSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        return parsed.success && parsed.data.repository === repository ? parsed.data : null;
      } catch {
        return null;
      }
    },
    write: (cache) => {
      rmSync(temporary, { force: true });
      writeNewFileDurably(temporary, `${JSON.stringify(cache)}\n`);
      renameSync(temporary, file);
      syncDirectory(dataDir);
    },
  };
}
