import { HEALTH_PATH } from "@openlife/contracts/http/health";
import type { MiddlewareHandler } from "hono";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";

const roundMs = (milliseconds: number): number => Math.max(0, Math.round(milliseconds * 1000) / 1000);

/**
 * One technical log line per finished request: method, the matched route TEMPLATE, status and
 * duration under the request's ID. Never the URL (it may carry a search), headers, cookies or
 * the body. A handler that threw has already been answered by the error handler, so the line
 * reports its 500. The health probe runs every few seconds and is logged at debug level only.
 */
export function requestLog(logger: TechnicalLogger, nowMs: () => number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = nowMs();
    await next();
    logger.log({
      level: c.req.path === HEALTH_PATH ? "debug" : "info",
      event: "http.request",
      requestId: c.get("requestId"),
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      durationMs: roundMs(nowMs() - started),
    });
  };
}
