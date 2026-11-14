// Durable writes of the file system adapters (Architektura §4.8, §11.4): a new file is created
// exclusively and flushed before it is renamed or published, and the directory entry of a
// rename is flushed too, so a crash leaves either the old or the new state on the same mount.
import { closeSync, fsyncSync, openSync, writeFileSync, writeSync } from "node:fs";

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

/**
 * Creates `file` (never replacing an existing one) and fills it from a stream of text, a part at a time, so a
 * large document is never held whole; the file is flushed when the stream ends. A failure leaves a partial file
 * for the caller to remove (the staging directory it lives in is discarded).
 */
export async function writeNewFileFromChunks(file: string, chunks: AsyncIterable<string>): Promise<number> {
  const fd = openSync(file, "wx", PRIVATE_FILE_MODE);
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      const encoded = Buffer.from(chunk, "utf8");
      let offset = 0;
      while (offset < encoded.length) offset += writeSync(fd, encoded, offset);
      bytes += encoded.length;
    }
    fsyncSync(fd);
    return bytes;
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
