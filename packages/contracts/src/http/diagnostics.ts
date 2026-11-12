import { z } from "zod";

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
