// Durable writes of the file system adapters (Architektura §4.8, §11.4): a new file is created
// exclusively and flushed before it is renamed or published, and the directory entry of a
// rename is flushed too, so a crash leaves either the old or the new state on the same mount.
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";

const PRIVATE_FILE_MODE = 0o600;

/** Creates `file` (never replacing an existing one), writes `content` and flushes it. */
export function writeNewFileDurably(file: string, content: string | Uint8Array): void {
  const fd = openSync(file, "wx", PRIVATE_FILE_MODE);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flushes an existing file, e.g. one written by another library. */
export function syncFile(file: string): void {
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flushes directory entries after a create or rename inside `dir`. */
export function syncDirectory(dir: string): void {
  // Windows cannot open a directory for fsync; NTFS orders the rename metadata itself.
  if (process.platform === "win32") {
    return;
  }
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
