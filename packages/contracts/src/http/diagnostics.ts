import { z } from "zod";
import { SETTING_SOURCES } from "./settings.js";

// The diagnostics of the installation over HTTP (Architektura §15.3; D44). One read for the owner whose
// session passes the gate of the private data: the versions, the paths of the host and of the container,
// the size of the data, the state of the technical log, the open streams and the latest errors. It carries
// no environment, no secret, no row of the database and no value of ConfigTable: the answer is built from
// a list of fields. A part of the system that does not exist yet (backup, updater, schedulers) says so.

export const DIAGNOSTICS_PATH = "/api/v1/diagnostics";

const pathText = z.string().min(1).max(1024);

/** The folders of the installation as the host sees them (a Windows host keeps its own separators). */
export const hostPathsSchema = z
  .object({ installation: pathText, database: pathText, backups: pathText, logs: pathText, tmp: pathText, instanceFile: pathText, maintenance: pathText })
  .strict();

/** The fixed paths inside the container of the application. */
export const containerPathsSchema = z.object({ database: pathText, backups: pathText, logs: pathText, tmp: pathText, instanceFile: pathText, maintenance: pathText }).strict();

/** One technical error of the log: when, which event and code, and the request it belongs to; never a message. */
export const recentErrorSchema = z
  .object({
    at: z.iso.datetime(),
    event: z.string().min(1).max(64),
    code: z.string().min(1).max(64).nullable(),
    requestId: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type RecentErrorDto = z.infer<typeof recentErrorSchema>;

/** A part whose module is not in the product yet. */
const missingPart = z.literal("not_available");

export const diagnosticsSchema = z
  .object({
    app: z
      .object({
        version: z.string().min(1).max(64),
        revision: z.string().min(1).max(64),
        schemaVersion: z.number().int().min(0),
        installMode: z.enum(["local", "server"]),
        instanceId: z.string().min(1).max(64),
        hostPlatform: z.enum(["posix", "windows"]),
      })
      .strict(),
    paths: z.object({ host: hostPathsSchema, container: containerPathsSchema }).strict(),
    storage: z
      .object({
        /** Null when the file cannot be read now. */
        databaseBytes: z.number().int().min(0).nullable(),
        walBytes: z.number().int().min(0).nullable(),
        dataFreeBytes: z.number().int().min(0).nullable(),
      })
      .strict(),
    logger: z.object({ degraded: z.boolean(), lostLines: z.number().int().min(0), queuedBytes: z.number().int().min(0) }).strict(),
    live: z.object({ connections: z.number().int().min(0) }).strict(),
    recentErrors: z.array(recentErrorSchema).max(20),
    parts: z.object({ backup: missingPart, updater: missingPart, schedulers: missingPart }).strict(),
  })
  .strict();
export type DiagnosticsDto = z.infer<typeof diagnosticsSchema>;

// The files of the technical log and the lines of one request (D44.2). The client names a file from the
// list, never a path: the server accepts only the names its own sink writes (`app.jsonl` and
// `app.<UTC>-<seq>.jsonl`), and only a plain file of a bounded size and age. The lines are the ones the
// logger wrote, already reduced to its closed set of fields.

export const DIAGNOSTICS_LOGS_PATH = "/api/v1/diagnostics/logs";
/** One file of the log: `GET` downloads it. */
export const DIAGNOSTICS_LOG_PATH = `${DIAGNOSTICS_LOGS_PATH}/:file` as const;
export const diagnosticsLogPath = (file: string): string => `${DIAGNOSTICS_LOGS_PATH}/${encodeURIComponent(file)}`;
/** The lines of the log that belong to one request id (the one an answer of the API carries). */
export const DIAGNOSTICS_REQUEST_PATH = "/api/v1/diagnostics/requests/:requestId" as const;
export const diagnosticsRequestPath = (requestId: string): string => `/api/v1/diagnostics/requests/${encodeURIComponent(requestId)}`;

/** The shape of a request id the search accepts: what the server issues, nothing that could be a path or a pattern. */
export const LOG_REQUEST_ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

export const logFileSchema = z
  .object({
    name: z.string().min(1).max(64),
    bytes: z.number().int().min(0),
    modifiedAt: z.iso.datetime(),
    /** The file being written now; the others are rotated. */
    active: z.boolean(),
  })
  .strict();
export type LogFileDto = z.infer<typeof logFileSchema>;

export const logFileListSchema = z.object({ files: z.array(logFileSchema).max(100) }).strict();
export type LogFileListDto = z.infer<typeof logFileListSchema>;

export const requestLogSchema = z
  .object({
    requestId: z.string().regex(LOG_REQUEST_ID_PATTERN),
    /** The lines as they are in the files, oldest first. */
    lines: z.array(z.string().max(16 * 1024)).max(100),
    /** More lines or more files than the search reads. */
    truncated: z.boolean(),
    filesSearched: z.number().int().min(0),
  })
  .strict();
export type RequestLogDto = z.infer<typeof requestLogSchema>;

// The diagnostic report (D44.3): one JSON file the owner downloads and reads, or sends to whoever helps, by
// their own hand. It is built from a list of fields: the overview, the effective application options with
// their source, and the list of the log files. It holds no database, no export, no environment, no `.env`, no
// audit with values and no content of a record or of ConfigTable, and it is never sent anywhere by the app.

export const DIAGNOSTICS_REPORT_PATH = "/api/v1/diagnostics/report";

export const REPORT_FORMAT_VERSION = 1;

export const reportOptionSchema = z
  .object({
    key: z.string().min(1).max(64),
    value: z.union([z.number(), z.boolean(), z.string().max(64)]),
    source: z.enum(SETTING_SOURCES),
  })
  .strict();

export const diagnosticReportSchema = z
  .object({
    formatVersion: z.literal(REPORT_FORMAT_VERSION),
    generatedAt: z.iso.datetime(),
    overview: diagnosticsSchema,
    options: z.array(reportOptionSchema).max(200),
    logFiles: z.array(logFileSchema).max(100),
  })
  .strict();
export type DiagnosticReportDto = z.infer<typeof diagnosticReportSchema>;
