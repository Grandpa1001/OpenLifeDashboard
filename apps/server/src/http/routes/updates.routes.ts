// The releases for the owner whose session passes the gate of the private data (Architektura §11.1; D53.3): the state of
// the check and "Check now". Neither takes an address or a version, and an answer is the contract's shape or a code: the
// source of the releases is the installation's. A check that is too soon, or that the source asked to wait for, is 429
// with the seconds to wait; an installation with no source says so and does nothing.
import { updatesCheckBodySchema, updatesCheckResultSchema, updatesInstallBodySchema, updatesInstallResultSchema, updatesStatusSchema, UPDATES_CHECK_PATH, UPDATES_INSTALL_PATH, UPDATES_PATH } from "@openlife/contracts/http/updates";
import { authorizeUpdateStart, type UpdateAuthorizationDependencies } from "@openlife/core/updates";
import { authorizeDataAccess, type DataAccessPorts } from "@openlife/core/identity";
import type { ReadUnit } from "@openlife/core/foundation";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { UpdateInstaller } from "../../workers/update-coordinator.js";
import type { UpdatesService } from "../../workers/release-check.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type UpdatesRouteDependencies = Readonly<{
  unit: ReadUnit<DataAccessPorts>;
  updates: UpdatesService;
  /** Starts an update and tells where it is; an installation without an updater has one that refuses (D54.4). */
  installer: UpdateInstaller;
  /** The access policy and the audit for the start of an update. */
  start: UpdateAuthorizationDependencies;
  newOperationId: () => string;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerUpdatesRoutes(app: Hono<AppEnv>, deps: UpdatesRouteDependencies): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  app.get(
    UPDATES_PATH,
    read(async (c, token) => {
      const holder = authorizeDataAccess(deps, token, c.get("requestId"));
      if (!holder.ok) return refused(c, holder.error);
      // Parsed against the contract: what does not fit it fails here instead of reaching the owner.
      return c.json(updatesStatusSchema.parse({ ...deps.updates.status(), operation: await deps.installer.operation() }));
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
      return c.json(updatesCheckResultSchema.parse({ ...result.status, operation: await deps.installer.operation(), outcome: result.outcome }));
    }),
  );

  app.post(
    UPDATES_INSTALL_PATH,
    ...guard,
    operation(updatesInstallBodySchema, async (c, token, body) => {
      // Who may start one is decided first and from the session alone (the gate and a fresh second factor), so a refusal of the
      // access never tells what an update could do; the start is audited only when nothing else already refuses it.
      const operationId = body.operationId ?? deps.newOperationId();
      const refusal = deps.installer.refusalFor(body.release, body.operationId);
      const authorized = authorizeUpdateStart(deps.start, token, { release: body.release, operationId }, c.get("requestId"), refusal === null && !deps.installer.resumes(body.operationId));
      if (!authorized.ok) return refused(c, authorized.error);
      if (refusal === "NOT_CONFIGURED") return apiErrorResponse(c, 409, "UPDATES_NOT_CONFIGURED");
      if (refusal === "RELEASE_UNKNOWN") return apiErrorResponse(c, 409, "UPDATE_RELEASE_UNKNOWN");
      if (refusal === "IN_PROGRESS" || refusal === "MAINTENANCE") return apiErrorResponse(c, 409, "UPDATE_IN_PROGRESS");
      const started = await deps.installer.start(body.release, operationId);
      if (!started.ok) {
        if (started.code === "NOT_CONFIGURED") return apiErrorResponse(c, 409, "UPDATES_NOT_CONFIGURED");
        if (started.code === "RELEASE_UNKNOWN") return apiErrorResponse(c, 409, "UPDATE_RELEASE_UNKNOWN");
        if (started.code === "IN_PROGRESS" || started.code === "MAINTENANCE") return apiErrorResponse(c, 409, "UPDATE_IN_PROGRESS");
        return apiErrorResponse(c, 503, "UPDATE_UNAVAILABLE", { code: started.detail ?? started.code });
      }
      return c.json(updatesInstallResultSchema.parse({ operationId: started.operationId, release: body.release, accepted: true }), 202);
    }),
  );
}
