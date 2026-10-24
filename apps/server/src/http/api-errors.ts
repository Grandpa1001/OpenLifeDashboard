import type { ApiError, ApiErrorCode } from "@openlife/contracts/http/errors";
import type { Context, ErrorHandler, Handler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./app-env.js";

const FALLBACK_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  NOT_FOUND: "Not found",
  INTERNAL_ERROR: "Internal server error",
};

export function apiErrorResponse(c: Context<AppEnv>, status: ContentfulStatusCode, code: ApiErrorCode): Response {
  const body: ApiError = { code, message: FALLBACK_MESSAGES[code], details: null, requestId: c.get("requestId") };
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
}

/** Unknown `/api` routes answer JSON, never the SPA document (Architektura §6.1). */
export const apiNotFound: Handler<AppEnv> = (c) => apiErrorResponse(c, 404, "NOT_FOUND");

/**
 * Last-resort handler. Only the request ID and the error type reach stderr; messages and
 * stacks may contain data and wait for the redacting logger of D06.
 */
export const unhandledError: ErrorHandler<AppEnv> = (error, c) => {
  console.error(JSON.stringify({ event: "http.unhandled_error", requestId: c.get("requestId"), error: error.name }));
  return apiErrorResponse(c, 500, "INTERNAL_ERROR");
};
