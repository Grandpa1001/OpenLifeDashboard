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
  AUTH_REQUIRED: "Sign in to continue",
  MFA_REQUIRED: "The second factor is required",
  RECOVERY_ACK_REQUIRED: "Confirm that the recovery codes are saved",
  SETUP_DATA_REQUIRED: "Choose the starting data first",
  SETUP_DATA_ALREADY_CHOSEN: "The starting data has already been chosen",
  STEP_UP_REQUIRED: "Confirm with a fresh code",
  MFA_INVALID_CODE: "The code is not valid",
  ENROLLMENT_CHANGED: "The enrollment is no longer in the state this request expects",
  RECOVERY_BATCH_CHANGED: "The recovery codes were replaced; use the current batch",
  REGISTRY_SYMBOL_TAKEN: "A registry with this symbol exists or existed",
  REGISTRY_LIMIT_EXCEEDED: "The limit of registries is reached",
  IDEMPOTENCY_CONFLICT: "This idempotency key was used for a different request",
  SCHEMA_CHANGED: "The registry changed since the form was loaded; reload it",
  RECORD_CONFLICT: "The record changed since the form was loaded; load the newer version",
  DICTIONARY_SYMBOL_TAKEN: "A dictionary with this symbol exists",
  DICTIONARY_LIMIT_EXCEEDED: "The limit of dictionaries is reached",
  DICTIONARY_CHANGED: "The dictionary changed since it was loaded; load it again",
  CONFIG_SYMBOL_TAKEN: "An entry with this symbol exists",
  CONFIG_LIMIT_EXCEEDED: "The limit of entries is reached",
  CONFIG_CHANGED: "The entry changed since it was loaded; load it again",
  PLAN_INVALID: "The plan is not one issued for this change; preview it again",
  PLAN_EXPIRED: "The plan has expired; preview the change again",
  PLAN_STALE: "The registry changed since the preview; preview the change again",
  SCREEN_LIMIT_EXCEEDED: "The limit of screens is reached",
  MAINTENANCE: "A maintenance operation is in progress; try again when it ends",
  SNAPSHOT_LOW_SPACE: "There is not enough free space for the copy the change needs; nothing was changed",
  SNAPSHOT_FAILED: "The copy the change needs could not be made; nothing was changed",
  EXPORT_UNAVAILABLE: "The export could not be made now",
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
