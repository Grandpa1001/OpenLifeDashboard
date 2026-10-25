// The technical log file of this process: data/logs/app/app.jsonl, one writer (this process,
// which holds the writer lease). Architektura §15.2 "Granice od D06":
//   - lines wait in a queue of at most 1 MiB and are written in a later turn of the event loop;
//     a burst beyond the limit is counted as lost, never buffered without bound;
//   - a line above 16 KiB, or above the file limit, never reaches a file;
//   - the active file is rotated BEFORE a line would exceed the file limit; rotated files are
//     named app.<UTC time>-<seq>.jsonl, at most `maxFiles` including the active one are kept and
//     rotated files older than the retention are removed — only files with exactly that name;
//   - a failing file (no permission, no space, a gone folder) makes the sink degraded: the
//     queue is dropped and counted, stderr gets one limited notice that never goes through the
//     log itself, the file is retried later, and stdout (another sink) keeps working;
//   - a write that stops half-way is cut back, so a line in the file is always a whole line.
// Nothing here can fail the caller: a lost log line is never a failed request or write.
import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { LOG_NOTICE_INTERVAL_MS, LOG_QUEUE_LIMIT_BYTES, LOG_REOPEN_INTERVAL_MS, MAX_LOG_LINE_BYTES } from "./limits.js";
import type { LogSink } from "./technical-logger.js";

export const APP_LOG_FILE = "app.jsonl";
const LOG_FILE_MODE = 0o600;
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
const ROTATED_NAME = /^app\.(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(\d{3})\.jsonl$/;
const MAX_ROTATIONS_PER_SECOND = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Rotation limits in bytes/files/days; read at every decision, so D41 can change them live. */
export type LogFileLimits = Readonly<{ fileMaxBytes: number; maxFiles: number; retentionDays: number }>;

export type RotatingFileSinkOptions = Readonly<{
  dir: string;
  limits: () => LogFileLimits;
  now: () => Date;
  /** Receives the rate-limited notices (stderr); it must not write to the log. */
  notify: (line: string) => void;
}>;

export type LogSinkStatus = Readonly<{
  degraded: boolean;
  /** Lines that could not be written: queue full, too large, or the file unavailable. */
  lostLines: number;
  queuedBytes: number;
  file: string;
}>;

export type RotatingFileSink = LogSink &
  Readonly<{
    status: () => LogSinkStatus;
    /** Writes what is queued now (shutdown, tests). */
    flush: () => void;
    /** Removes rotated files over the age or count limit; called after rotation and hourly. */
    enforceRetention: () => void;
    /** Flushes and releases the file; later lines are counted as lost. */
    close: () => void;
  }>;

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

function stamp(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z`;
}

/** UTC time encoded in a rotated file's name, or undefined for any other name. */
function rotatedAt(name: string): number | undefined {
  const match = ROTATED_NAME.exec(name);
  if (!match) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute, second);
}

const isRegularFile = (file: string): boolean => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};

export function createRotatingFileSink(options: RotatingFileSinkOptions): RotatingFileSink {
  const activeFile = path.join(options.dir, APP_LOG_FILE);
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let lostLines = 0;
  let degraded = false;
  let closed = false;
  let scheduled = false;
  let fd: number | undefined;
  let size = 0;
  let nextOpenAt = 0;
  let lastNoticeAt = Number.NEGATIVE_INFINITY;

  const closeQuietly = (): void => {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is gone either way.
      }
      fd = undefined;
    }
  };

  function open(): void {
    const opened = openSync(activeFile, OPEN_FLAGS, LOG_FILE_MODE);
    try {
      const stats = fstatSync(opened);
      if (!stats.isFile()) {
        throw new Error("the log file is not a regular file");
      }
      size = stats.size;
    } catch (error) {
      closeSync(opened);
      throw error;
    }
    fd = opened;
  }

  function enforceRetention(): void {
    let names: string[];
    try {
      names = readdirSync(options.dir);
    } catch {
      return;
    }
    const { maxFiles, retentionDays } = options.limits();
    const nowMs = options.now().getTime();
    // Only regular files with exactly the rotated name; a symlink or any other file is not ours.
    const rotated = names
      .filter((name) => rotatedAt(name) !== undefined && isRegularFile(path.join(options.dir, name)))
      .sort();
    const remove = (name: string): void => {
      try {
        unlinkSync(path.join(options.dir, name));
      } catch {
        // Retention is best effort; a file that stays is tried again at the next sweep.
      }
    };
    const fresh = rotated.filter((name) => {
      const age = nowMs - (rotatedAt(name) ?? nowMs);
      if (age > retentionDays * DAY_MS) {
        remove(name);
        return false;
      }
      return true;
    });
    // The active file counts towards maxFiles: keep the newest maxFiles - 1 rotated ones.
    fresh.slice(0, Math.max(0, fresh.length - (maxFiles - 1))).forEach(remove);
  }

  function rotate(): void {
    closeQuietly();
    const base = stamp(options.now());
    let target: string | undefined;
    for (let sequence = 0; sequence < MAX_ROTATIONS_PER_SECOND && target === undefined; sequence += 1) {
      const candidate = path.join(options.dir, `app.${base}-${pad(sequence, 3)}.jsonl`);
      try {
        lstatSync(candidate);
      } catch {
        target = candidate;
      }
    }
    if (target === undefined) {
      throw new Error("no free rotated file name in this second");
    }
    renameSync(activeFile, target);
    open();
    enforceRetention();
  }

  /** Writes one whole line or none: a partial write is cut back before the error is raised. */
  function writeLine(line: Buffer): void {
    if (fd === undefined) {
      throw new Error("the log file is not open");
    }
    let written: number;
    try {
      written = writeSync(fd, line);
    } catch (error) {
      cutBack();
      throw error;
    }
    if (written < line.length) {
      cutBack();
      throw new Error("short write to the log file");
    }
    size += line.length;
  }

  function cutBack(): void {
    if (fd !== undefined) {
      try {
        ftruncateSync(fd, size);
      } catch {
        // The torn tail stays only if even that fails; the next start appends after it.
      }
    }
  }

  function notice(): void {
    const nowMs = options.now().getTime();
    if (nowMs - lastNoticeAt >= LOG_NOTICE_INTERVAL_MS) {
      lastNoticeAt = nowMs;
      options.notify(`${JSON.stringify({ event: "logger.sink_degraded", code: "LOG_SINK_UNAVAILABLE", lostLines })}\n`);
    }
  }

  function dropQueue(): void {
    lostLines += queue.length;
    queue.length = 0;
    queuedBytes = 0;
  }

  function fail(): void {
    dropQueue();
    degraded = true;
    closeQuietly();
    nextOpenAt = options.now().getTime() + LOG_REOPEN_INTERVAL_MS;
    notice();
  }

  function drain(): void {
    if (queue.length === 0) {
      return;
    }
    if (fd === undefined && options.now().getTime() < nextOpenAt) {
      // Degraded and not yet time to try again: the lines are lost and counted, the notice is
      // limited, and the retry time stays where the failure put it.
      dropQueue();
      notice();
      return;
    }
    try {
      if (fd === undefined) {
        open();
      }
      while (queue.length > 0) {
        const line = queue[0];
        if (line === undefined) {
          break;
        }
        const { fileMaxBytes } = options.limits();
        if (line.length > fileMaxBytes) {
          // A line that could never fit a file is not written to an unbounded one.
          lostLines += 1;
        } else {
          if (size + line.length > fileMaxBytes) {
            rotate();
          }
          writeLine(line);
        }
        queue.shift();
        queuedBytes -= line.length;
      }
      degraded = false;
    } catch {
      fail();
    }
  }

  function schedule(): void {
    if (!scheduled) {
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        drain();
      });
    }
  }

  return {
    write(line) {
      const bytes = Buffer.from(line, "utf8");
      if (closed || bytes.length > MAX_LOG_LINE_BYTES || queuedBytes + bytes.length > LOG_QUEUE_LIMIT_BYTES) {
        lostLines += 1;
        return;
      }
      queue.push(bytes);
      queuedBytes += bytes.length;
      schedule();
    },
    status: () => ({ degraded, lostLines, queuedBytes, file: activeFile }),
    flush: drain,
    enforceRetention,
    close() {
      if (!closed) {
        drain();
        closed = true;
        closeQuietly();
      }
    },
  };
}
