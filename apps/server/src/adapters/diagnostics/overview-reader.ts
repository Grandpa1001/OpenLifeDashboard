// The overview of the installation for the owner (Architektura §15.3; D44.1): versions, paths, sizes, the
// state of the technical log, the open streams and the latest errors. Every field is named here and filled
// from a trusted source (the build, the metadata of the installation, the sizes of two files, the status of
// the sink); nothing comes from the request, and nothing is copied from the log but a time, an event name,
// a code and a request id, each checked for its shape. A source that cannot be read gives null or an empty
// list, never a failure of the overview.
import { constants } from "node:fs";
import { lstat, open, statfs } from "node:fs/promises";
import path from "node:path";
import type { DiagnosticsDto, RecentErrorDto } from "@openlife/contracts/http/diagnostics";
import type { AppBuild } from "../filesystem/database-snapshots.js";
import type { InstallationPaths, WorkingPaths } from "../filesystem/installation-paths.js";
import { APP_LOG_FILE, type LogSinkStatus } from "../logging/rotating-file-sink.js";
import { RECENT_ERRORS_MAX, RECENT_ERRORS_TAIL_BYTES } from "./limits.js";

export type OverviewReaderOptions = Readonly<{
  build: AppBuild;
  schemaVersion: number;
  installation: InstallationPaths;
  /** The paths the process works with: the files read here, not the ones shown. */
  workingPaths: WorkingPaths;
  logStatus: () => LogSinkStatus;
  liveConnections: () => number;
}>;

export type OverviewReader = () => Promise<DiagnosticsDto>;

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const CODE = /^[A-Z][A-Z0-9_]*$/;
const REQUEST_ID = /^[0-9A-Za-z-]{1,64}$/;

/** The size of a regular file; a missing file, a link or anything else is null. */
async function fileSize(file: string): Promise<number | null> {
  try {
    const stats = await lstat(file);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

async function freeBytes(folder: string): Promise<number | null> {
  try {
    const stats = await statfs(folder);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** One line of the log as an error of the overview, or null when it is not an error or has a field of the wrong shape. */
function recentErrorOf(line: string): RecentErrorDto | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "level") !== "error") return null;
  const at = Reflect.get(parsed, "timestamp");
  const event = Reflect.get(parsed, "event");
  const code = Reflect.get(parsed, "code");
  const requestId = Reflect.get(parsed, "requestId");
  if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || typeof event !== "string" || !EVENT_NAME.test(event) || event.length > 64) return null;
  return {
    at: new Date(at).toISOString(),
    event,
    code: typeof code === "string" && CODE.test(code) && code.length <= 64 ? code : null,
    requestId: typeof requestId === "string" && REQUEST_ID.test(requestId) ? requestId : null,
  };
}

/** The latest errors of the active log, newest first: only the end of the file is read, and only a plain file is opened. */
async function recentErrors(logFile: string): Promise<RecentErrorDto[]> {
  const size = await fileSize(logFile);
  if (size === null || size === 0) return [];
  let handle;
  try {
    handle = await open(logFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const length = Math.min(size, RECENT_ERRORS_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    // A tail that starts inside a line begins with a piece of it: that piece is not a line.
    if (size > length) lines.shift();
    const errors: RecentErrorDto[] = [];
    for (let at = lines.length - 1; at >= 0 && errors.length < RECENT_ERRORS_MAX; at -= 1) {
      const error = recentErrorOf(lines[at] ?? "");
      if (error !== null) errors.push(error);
    }
    return errors;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createOverviewReader(options: OverviewReaderOptions): OverviewReader {
  const { build, installation, workingPaths } = options;
  return async () => {
    const sink = options.logStatus();
    const [databaseBytes, walBytes, dataFreeBytes, errors] = await Promise.all([
      fileSize(workingPaths.database),
      fileSize(`${workingPaths.database}-wal`),
      freeBytes(path.dirname(workingPaths.database)),
      recentErrors(path.join(workingPaths.logs, APP_LOG_FILE)),
    ]);
    return {
      app: {
        version: build.appVersion,
        revision: build.buildRevision,
        schemaVersion: options.schemaVersion,
        installMode: installation.installMode,
        instanceId: installation.instanceId,
        hostPlatform: installation.hostPlatform,
      },
      paths: {
        host: installation.host,
        container: installation.container,
      },
      storage: { databaseBytes, walBytes, dataFreeBytes },
      logger: { degraded: sink.degraded, lostLines: sink.lostLines, queuedBytes: sink.queuedBytes },
      live: { connections: options.liveConnections() },
      recentErrors: errors,
      parts: { backup: "not_available", updater: "not_available", schedulers: "not_available" },
    };
  };
}
