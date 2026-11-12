// The diagnostics of the installation (Architektura §15.3; D44) for the owner whose session passes the gate of
// the private data: the overview (D44.1), the files of the technical log with their download, and the lines of
// one request (D44.2). The readers of the adapters decide what may be read; the routes only ask the gate and
// answer. Nothing is cached, and nothing in a request is a path: a file is named from the list and refused
// when it is not on it.
import {
  DIAGNOSTICS_LOG_PATH,
  DIAGNOSTICS_LOGS_PATH,
  DIAGNOSTICS_PATH,
  DIAGNOSTICS_REQUEST_PATH,
  diagnosticsSchema,
  LOG_REQUEST_ID_PATTERN,
  logFileListSchema,
  requestLogSchema,
} from "@openlife/contracts/http/diagnostics";
import { authorizeDataAccess, type DataAccessPorts } from "@openlife/core/identity";
import type { ReadUnit } from "@openlife/core/foundation";
import type { Hono } from "hono";
import type { LogFiles } from "../../adapters/diagnostics/log-files.js";
import type { OverviewReader } from "../../adapters/diagnostics/overview-reader.js";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type DiagnosticsRouteDependencies = Readonly<{
  unit: ReadUnit<DataAccessPorts>;
  overview: OverviewReader;
  logs: LogFiles;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerDiagnosticsRoutes(app: Hono<AppEnv>, deps: DiagnosticsRouteDependencies): void {
  const { read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  app.get(
    DIAGNOSTICS_PATH,
    read(async (c, token) => {
      const holder = authorizeDataAccess(deps, token, c.get("requestId"));
      if (!holder.ok) return refused(c, holder.error);
      // Parsed against the contract: a field that does not fit it fails here instead of reaching the owner.
      return c.json(diagnosticsSchema.parse(await deps.overview()));
    }),
  );

  app.get(
    DIAGNOSTICS_LOGS_PATH,
    read(async (c, token) => {
      const holder = authorizeDataAccess(deps, token, c.get("requestId"));
      if (!holder.ok) return refused(c, holder.error);
      return c.json(logFileListSchema.parse({ files: await deps.logs.list() }));
    }),
  );

  app.get(
    DIAGNOSTICS_LOG_PATH,
    read(async (c, token) => {
      const holder = authorizeDataAccess(deps, token, c.get("requestId"));
      if (!holder.ok) return refused(c, holder.error);
      const file = await deps.logs.open(c.req.param("file") ?? "");
      if (file === null) return refused(c, { code: "NOT_FOUND" });
      return new Response(file.body, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          // The browser saves it and does not render it; the name is one of the sink's own, so it needs no quoting.
          "Content-Disposition": `attachment; filename="${file.name}"`,
          "Content-Length": String(file.bytes),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }),
  );

  app.get(
    DIAGNOSTICS_REQUEST_PATH,
    read(async (c, token) => {
      const holder = authorizeDataAccess(deps, token, c.get("requestId"));
      if (!holder.ok) return refused(c, holder.error);
      const requestId = c.req.param("requestId") ?? "";
      if (!LOG_REQUEST_ID_PATTERN.test(requestId)) return refused(c, { code: "VALIDATION_FAILED" });
      return c.json(requestLogSchema.parse({ requestId, ...(await deps.logs.search(requestId)) }));
    }),
  );
}
