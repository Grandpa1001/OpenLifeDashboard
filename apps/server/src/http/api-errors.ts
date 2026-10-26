import type { ApiError, ApiErrorCode } from "@openlife/contracts/http/errors";
import type { Context, ErrorHandler, Handler, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import type { AppEnv } from "./app-env.js";

const FALLBACK_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  NOT_FOUND: "Not found",
  INTERNAL_ERROR: "Internal server error",
  VALIDATION_FAILED: "The request is not valid",
  ORIGIN_FORBIDDEN: "The request origin is not allowed",
  INVALID_CREDENTIALS: "E-mail or password is incorrect",
  AUTH_LOCKED: "Too many failed attempts; try again later",
  RATE_LIMITED: "Too many requests; try again later",
  AUTH_UNAVAILABLE: "Sign-in is temporarily unavailable",
};

export function apiErrorResponse(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  details: ApiError["details"] = null,
): Response {
  const body: ApiError = { code, message: FALLBACK_MESSAGES[code], details, requestId: c.get("requestId") };
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
}

/** Unknown `/api` routes answer JSON, never the SPA document (Architektura §6.1). */
export const apiNotFound: Handler<AppEnv> = (c) => apiErrorResponse(c, 404, "NOT_FOUND");

/**
 * Last-resort handler: answers 500 INTERNAL_ERROR with the request ID and logs the failure under
 * that same ID. The log carries only the error's class name, code and cause chain; messages and
 * stacks may contain data and never reach it (describe-error.ts).
 */
export function unhandledError(logger: TechnicalLogger): ErrorHandler<AppEnv> {
  return (error, c) => {
    logger.log({ level: "error", event: "http.unhandled_error", requestId: c.get("requestId"), error });
    return apiErrorResponse(c, 500, "INTERNAL_ERROR");
  };
}

/**
 * Hono hands only `Error` objects to the error handler; a thrown string or plain object would
 * leave the framework and the client would get a bare 500 without the request ID, with nothing
 * in the log. This guard sits inside the request log and answers such a value exactly like an
 * error: INTERNAL_ERROR with the ID, logged under it as a non-error (its content is never read).
 */
export function containThrownValues(logger: TechnicalLogger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
      return undefined;
    } catch (thrown) {
      logger.log({ level: "error", event: "http.unhandled_error", requestId: c.get("requestId"), error: thrown });
      return apiErrorResponse(c, 500, "INTERNAL_ERROR");
    }
  };
}
