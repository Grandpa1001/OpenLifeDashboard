import type { Hono, MiddlewareHandler } from "hono";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import type { AppEnv } from "./app-env.js";
import { containThrownValues, unhandledError } from "./api-errors.js";
import { requestId } from "./middleware/request-id.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { requestLog } from "./middleware/request-log.js";

export type HttpFoundationDependencies = Readonly<{
  newRequestId: () => string;
  logger: TechnicalLogger;
  /** Monotonic milliseconds, e.g. performance.now. */
  nowMs: () => number;
  /** Sets the client address of every request (D60.2). Only the tests that never read it leave it out. */
  clientAddress?: MiddlewareHandler<AppEnv>;
}>;

/**
 * What every request passes before any route: the security headers, a server-side request ID, the client address, the request log, the guard
 * for thrown values that are not errors and the error handler; both answer with that ID and log
 * the failure under it. The composition root
 * and the tests use this one function, so the order cannot drift apart.
 */
export function installHttpFoundation(app: Hono<AppEnv>, dependencies: HttpFoundationDependencies): void {
  app.use("*", securityHeaders());
  app.use("*", requestId(dependencies.newRequestId));
  if (dependencies.clientAddress !== undefined) app.use("*", dependencies.clientAddress);
  app.use("*", requestLog(dependencies.logger, dependencies.nowMs));
  app.use("*", containThrownValues(dependencies.logger));
  app.onError(unhandledError(dependencies.logger));
}
