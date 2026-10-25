// The technical log file of this process: data/logs/app/app.jsonl, one writer (this process,
// which holds the writer lease). Append-only through a descriptor opened without following
// symlinks. D06.1 writes synchronously and keeps one file; rotation, size limits, the bounded
// queue and the degraded state of an unwritable sink are D06.2 and replace this sink's internals.
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import type { LogSink } from "./technical-logger.js";

export const APP_LOG_FILE = "app.jsonl";
const LOG_FILE_MODE = 0o600;
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);

export type FileSink = LogSink & Readonly<{ file: string; close: () => void }>;

/** The sink for `<dir>/app.jsonl`, or undefined when the file cannot be opened (stdout stays). */
export function openAppLogFile(dir: string): FileSink | undefined {
  const file = path.join(dir, APP_LOG_FILE);
  let fd: number;
  try {
    fd = openSync(file, OPEN_FLAGS, LOG_FILE_MODE);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return undefined;
    }
  } catch {
    return undefined;
  }
  let open = true;
  return {
    file,
    write(line) {
      if (open) {
        writeSync(fd, line);
      }
    },
    close() {
      if (open) {
        open = false;
        closeSync(fd);
      }
    },
  };
}
