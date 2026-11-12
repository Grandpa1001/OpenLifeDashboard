// The diagnostics of the installation (Architektura §15.3; D44): `GET /api/v1/diagnostics` for the owner whose
// session passes the gate of the private data. The overview is built from a list of fields by the reader of
// the adapters; the route only asks the gate and answers. Nothing is cached, and nothing in the request
// decides what is read.
import { DIAGNOSTICS_PATH, diagnosticsSchema } from "@openlife/contracts/http/diagnostics";
import { authorizeDataAccess, type DataAccessPorts } from "@openlife/core/identity";
import type { ReadUnit } from "@openlife/core/foundation";
import type { Hono } from "hono";
import type { OverviewReader } from "../../adapters/diagnostics/overview-reader.js";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type DiagnosticsRouteDependencies = Readonly<{
  unit: ReadUnit<DataAccessPorts>;
  overview: OverviewReader;
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
}
