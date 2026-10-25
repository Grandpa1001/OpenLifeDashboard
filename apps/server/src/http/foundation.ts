import type { Hono } from "hono";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import type { AppEnv } from "./app-env.js";
import { containThrownValues, unhandledError } from "./api-errors.js";
import { requestId } from "./middleware/request-id.js";
import { requestLog } from "./middleware/request-log.js";

export type HttpFoundationDependencies = Readonly<{
  newRequestId: () => string;
  logger: TechnicalLogger;
  /** Monotonic milliseconds, e.g. performance.now. */
  nowMs: () => number;
}>;

/**
 * What every request passes before any route: a server-side request ID, the request log, the guard
 * for thrown values that are not errors and the error handler; both answer with that ID and log
 * the failure under it. The composition root
 * and the tests use this one function, so the order cannot drift apart.
 */
export function installHttpFoundation(app: Hono<AppEnv>, dependencies: HttpFoundationDependencies): void {
  app.use("*", requestId(dependencies.newRequestId));
  app.use("*", requestLog(dependencies.logger, dependencies.nowMs));
  app.use("*", containThrownValues(dependencies.logger));
  app.onError(unhandledError(dependencies.logger));
}
