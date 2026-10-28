// The frame every route of a signed-in owner shares (Architektura §9.7, §18.7): a browser mutation
// with a matching Origin, a small strict body, no caching, a verified session cookie, and an error
// in a unit of work (a failing audit included) answered as unavailable, never as a result. Reads
// (GET) have the same frame without a body and without the Origin check.
import type { ApiErrorCode } from "@openlife/contracts/http/errors";
import type { Failure } from "@openlife/core/foundation";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { SignedCookie } from "../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "./api-errors.js";
import type { AppEnv } from "./app-env.js";
import { requireSameOrigin } from "./middleware/same-origin.js";
import { readSessionToken } from "./session-cookie-http.js";

/** A second-factor request is a few short fields; more is refused before it is read. */
const BODY_MAX_BYTES = 1024;

const STATUS: Readonly<Partial<Record<ApiErrorCode, 401 | 403 | 404 | 409 | 422 | 429>>> = {
  AUTH_LOCKED: 429,
  AUTH_REQUIRED: 401,
  MFA_INVALID_CODE: 401,
  MFA_REQUIRED: 403,
  RECOVERY_ACK_REQUIRED: 403,
  SETUP_DATA_REQUIRED: 403,
  STEP_UP_REQUIRED: 403,
  ENROLLMENT_CHANGED: 409,
  RECOVERY_BATCH_CHANGED: 409,
  SETUP_DATA_ALREADY_CHOSEN: 409,
  REGISTRY_SYMBOL_TAKEN: 409,
  REGISTRY_LIMIT_EXCEEDED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SCHEMA_CHANGED: 409,
  SCREEN_LIMIT_EXCEEDED: 409,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
};

export type SessionOperationKit = Readonly<{
  /** Origin check and body limit, in this order, before the handler. */
  guard: readonly [ReturnType<typeof requireSameOrigin>, ReturnType<typeof bodyLimit>];
  operation: <S extends z.ZodType>(schema: S, run: (c: Context<AppEnv>, token: string, body: z.infer<S>) => Promise<Response>) => (c: Context<AppEnv>) => Promise<Response>;
  /** A read: no body, no Origin check (a safe method), the same session and error handling. */
  read: (run: (c: Context<AppEnv>, token: string) => Promise<Response> | Response) => (c: Context<AppEnv>) => Promise<Response>;
  /** The answer for a use case's failure; a lock carries Retry-After and the seconds in its details. */
  refused: (c: Context<AppEnv>, failure: Failure) => Response;
}>;

export function createSessionOperationKit(
  options: Readonly<{ allowedOrigin: string; cookies: SignedCookie; logger: TechnicalLogger; /** Largest body of a mutation; the second-factor and setup routes keep the small default. */ bodyMaxBytes?: number }>,
): SessionOperationKit {
  return {
    guard: [
      requireSameOrigin(options.allowedOrigin),
      bodyLimit({ maxSize: options.bodyMaxBytes ?? BODY_MAX_BYTES, onError: (c: Context<AppEnv>) => apiErrorResponse(c, 422, "VALIDATION_FAILED") }),
    ],
    operation: (schema, run) => async (c) => {
      c.header("Cache-Control", "no-store");
      const body = schema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) {
        return apiErrorResponse(c, 422, "VALIDATION_FAILED");
      }
      const token = await readSessionToken(c, options.cookies);
      if (token === null) {
        return apiErrorResponse(c, 401, "AUTH_REQUIRED");
      }
      try {
        return await run(c, token, body.data);
      } catch (error) {
        options.logger.log({ level: "error", event: "mfa.unavailable", requestId: c.get("requestId"), code: "AUTH_UNAVAILABLE", error });
        return apiErrorResponse(c, 503, "AUTH_UNAVAILABLE");
      }
    },
    read: (run) => async (c) => {
      c.header("Cache-Control", "no-store");
      const token = await readSessionToken(c, options.cookies);
      if (token === null) {
        return apiErrorResponse(c, 401, "AUTH_REQUIRED");
      }
      try {
        return await run(c, token);
      } catch (error) {
        options.logger.log({ level: "error", event: "session.unavailable", requestId: c.get("requestId"), code: "AUTH_UNAVAILABLE", error });
        return apiErrorResponse(c, 503, "AUTH_UNAVAILABLE");
      }
    },
    refused: (c, failure) => {
      const known = failure.code as ApiErrorCode;
      if (failure.code === "AUTH_LOCKED" && failure.retryAfterSeconds !== undefined) {
        c.header("Retry-After", String(failure.retryAfterSeconds));
        return apiErrorResponse(c, 429, "AUTH_LOCKED", { retryAfterSeconds: failure.retryAfterSeconds });
      }
      // A rejected definition lists where and why (stable codes, never the values).
      return apiErrorResponse(c, STATUS[known] ?? 409, known, failure.issues === undefined ? null : { issues: failure.issues });
    },
  };
}
