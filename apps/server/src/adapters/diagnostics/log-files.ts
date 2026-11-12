// The files of the technical log for the owner (Architektura §15.3; D44.2): a list, a download and a search by
// request id, from a closed set. A name is accepted only if it is one the sink writes (`app.jsonl` or
// `app.<UTC>-<seq>.jsonl`); the file must be a plain file (a link is refused: it is opened without following
// one, and checked again on the open descriptor), no larger than the bound, and a rotated file no older than
// the retention. The client never supplies a path, so there is nothing to traverse. The lines are those the
// logger wrote; the search returns the ones whose own request id is exactly the one asked for.
import { constants } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { LogFileDto, RequestLogDto } from "@openlife/contracts/http/diagnostics";
import { APP_LOG_FILE, rotatedAt } from "../logging/rotating-file-sink.js";
import { LOG_FILE_MAX_BYTES, LOG_FILES_LISTED_MAX, REQUEST_LOG_MAX_LINES, REQUEST_LOG_MAX_SCAN_BYTES } from "./limits.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type LogFilesOptions = Readonly<{
  dir: string;
  /** Read at each use: a change of `logs.retentionDays` applies from the next call. */
  retentionDays: () => number;
  now: () => Date;
  /** Tests narrow the bound; the product uses the constant. */
  maxFileBytes?: number;
  maxScanBytes?: number;
}>;

export type OpenedLogFile = Readonly<{ name: string; bytes: number; body: ReadableStream<Uint8Array> }>;

export type LogFiles = Readonly<{
  list: () => Promise<LogFileDto[]>;
  /** The file's bytes as they are now, or null for a name that is not on the list. */
  open: (name: string) => Promise<OpenedLogFile | null>;
  search: (requestId: string) => Promise<Omit<RequestLogDto, "requestId">>;
}>;

/** True for the two kinds of names the sink writes. */
const isLogFileName = (name: string): boolean => name === APP_LOG_FILE || rotatedAt(name) !== undefined;

export function createLogFiles(options: LogFilesOptions): LogFiles {
  const maxFileBytes = options.maxFileBytes ?? LOG_FILE_MAX_BYTES;
  const maxScanBytes = options.maxScanBytes ?? REQUEST_LOG_MAX_SCAN_BYTES;
  const fresh = (name: string): boolean => {
    const at = rotatedAt(name);
    return at === undefined || options.now().getTime() - at <= options.retentionDays() * DAY_MS;
  };

  /** A handle on the plain file of this name, or null; the descriptor, not the name, is what was checked. */
  async function openPlain(name: string): Promise<{ handle: FileHandle; bytes: number; modifiedAt: Date } | null> {
    if (!isLogFileName(name) || !fresh(name)) return null;
    let handle: FileHandle | undefined;
    try {
      handle = await open(path.join(options.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maxFileBytes) {
        await handle.close();
        return null;
      }
      return { handle, bytes: stats.size, modifiedAt: stats.mtime };
    } catch {
      await handle?.close().catch(() => undefined);
      return null;
    }
  }

  async function list(): Promise<LogFileDto[]> {
    let names: string[];
    try {
      names = await readdir(options.dir);
    } catch {
      return [];
    }
    const files: LogFileDto[] = [];
    for (const name of names.filter(isLogFileName).filter(fresh)) {
      try {
        // lstat names a link as a link: it is not a plain file and is left out.
        const stats = await lstat(path.join(options.dir, name));
        if (stats.isFile() && stats.size <= maxFileBytes) files.push({ name, bytes: stats.size, modifiedAt: stats.mtime.toISOString(), active: name === APP_LOG_FILE });
      } catch {
        // Gone between the listing and the check (rotation): it is not on the list.
      }
    }
    // The active file first, then the rotated ones, newest first (the names sort by time).
    files.sort((a, b) => Number(b.active) - Number(a.active) || (a.name < b.name ? 1 : -1));
    return files.slice(0, LOG_FILES_LISTED_MAX);
  }

  async function openFile(name: string): Promise<OpenedLogFile | null> {
    const plain = await openPlain(name);
    if (plain === null) return null;
    if (plain.bytes === 0) {
      await plain.handle.close();
      return { name, bytes: 0, body: new Response(new Uint8Array(0)).body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }) };
    }
    // Only the bytes that were there at the check are sent, though the sink goes on appending.
    const stream = plain.handle.createReadStream({ start: 0, end: plain.bytes - 1, autoClose: true });
    return { name, bytes: plain.bytes, body: Readable.toWeb(stream) as ReadableStream<Uint8Array> };
  }

  async function search(requestId: string): Promise<Omit<RequestLogDto, "requestId">> {
    // Oldest first, so the lines come in the order they were written.
    const files = (await list()).reverse();
    const lines: string[] = [];
    let scanned = 0;
    let filesSearched = 0;
    let truncated = false;
    for (const file of files) {
      if (scanned + file.bytes > maxScanBytes) {
        truncated = true;
        break;
      }
      const plain = await openPlain(file.name);
      if (plain === null) continue;
      scanned += plain.bytes;
      filesSearched += 1;
      try {
        for await (const line of plain.handle.readLines({ start: 0, end: Math.max(0, plain.bytes - 1) })) {
          if (!line.includes(requestId) || !ownRequestId(line, requestId)) continue;
          if (lines.length >= REQUEST_LOG_MAX_LINES) {
            truncated = true;
            break;
          }
          lines.push(line);
        }
      } finally {
        await plain.handle.close().catch(() => undefined);
      }
      if (truncated) break;
    }
    return { lines, truncated, filesSearched };
  }

  return { list, open: openFile, search };
}

/** The line is a JSON object whose own request id is this one (a request id that only appears inside another value does not count). */
function ownRequestId(line: string, requestId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && Reflect.get(parsed, "requestId") === requestId;
  } catch {
    return false;
  }
}
