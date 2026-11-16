// The releases for the owner whose session passes the gate of the private data (Architektura §11.1; D53.3): the state of
// the check and "Check now". Neither takes an address or a version, and an answer is the contract's shape or a code: the
// source of the releases is the installation's. A check that is too soon, or that the source asked to wait for, is 429
// with the seconds to wait; an installation with no source says so and does nothing.
import { updatesCheckBodySchema, updatesCheckResultSchema, updatesStatusSchema, UPDATES_CHECK_PATH, UPDATES_PATH } from "@openlife/contracts/http/updates";
import { authorizeDataAccess, type DataAccessPorts } from "@openlife/core/identity";
import type { ReadUnit } from "@openlife/core/foundation";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { UpdatesService } from "../../workers/release-check.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type UpdatesRouteDependencies = Readonly<{
  unit: ReadUnit<DataAccessPorts>;
  updates: UpdatesService;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerUpdatesRoutes(app: Hono<AppEnv>, deps: UpdatesRouteDependencies): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  app.get(
    UPDATES_PATH,
    read((c, token) => {
      const holder = authorizeDataAccess(deps, token, c.get("requestId"));
      if (!holder.ok) return refused(c, holder.error);
      // Parsed against the contract: what does not fit it fails here instead of reaching the owner.
      return c.json(updatesStatusSchema.parse(deps.updates.status()));
    }),
  );

  app.post(
    UPDATES_CHECK_PATH,
    ...guard,
    operation(updatesCheckBodySchema, async (c, token) => {
      const holder = authorizeDataAccess(deps, token, c.get("requestId"));
      if (!holder.ok) return refused(c, holder.error);
      const result = await deps.updates.checkNow();
      if (!result.ok) {
        if (result.reason === "NOT_CONFIGURED") return apiErrorResponse(c, 409, "UPDATES_NOT_CONFIGURED");
        if (result.retryAfterSeconds !== null) c.header("Retry-After", String(result.retryAfterSeconds));
        return apiErrorResponse(c, 429, "UPDATE_CHECK_THROTTLED", { reason: result.reason, retryAfterSeconds: result.retryAfterSeconds });
      }
      return c.json(updatesCheckResultSchema.parse({ ...result.status, outcome: result.outcome }));
    }),
  );
}
