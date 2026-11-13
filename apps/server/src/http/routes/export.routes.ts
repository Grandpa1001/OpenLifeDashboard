// The export of the whole domain data (Architektura Załącznik G; D45.2): `GET /api/v1/export` for the owner
// whose session passes the gate of the private data. No step-up (the appendix decides so; the page warns that
// the file holds personal data). The file is streamed from a consistent view of the database made for this
// request, so it is neither held in memory nor does it stop the writer or the live stream; it is named by the
// day, and nothing in the request chooses what it holds.
import { authorizeDataAccess, type DataAccessPorts } from "@openlife/core/identity";
import type { ReadUnit } from "@openlife/core/foundation";
import { EXPORT_PATH } from "@openlife/contracts/http/export";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { ExportService } from "../../portability/export-stream.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type ExportRouteDependencies = Readonly<{
  unit: ReadUnit<DataAccessPorts>;
  export: ExportService;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerExportRoutes(app: Hono<AppEnv>, deps: ExportRouteDependencies): void {
  const { read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  app.get(
    EXPORT_PATH,
    read(async (c, token) => {
      const requestId = c.get("requestId");
      const holder = authorizeDataAccess(deps, token, requestId);
      if (!holder.ok) return refused(c, holder.error);
      let exported;
      try {
        exported = await deps.export(requestId);
      } catch (error) {
        deps.logger.log({ level: "error", event: "export.unavailable", requestId, code: "EXPORT_UNAVAILABLE", error });
        return apiErrorResponse(c, 503, "EXPORT_UNAVAILABLE");
      }
      return new Response(exported.body, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exported.fileName}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    }),
  );
}
