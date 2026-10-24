import { REQUEST_ID_HEADER } from "@openlife/contracts/http/errors";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";

/**
 * Assigns every request a fresh server-side ID. An incoming X-Request-Id is ignored so that a
 * client cannot choose the identifier that links its response to server logs.
 */
export function requestId(generate: () => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const id = generate();
    c.set("requestId", id);
    c.header(REQUEST_ID_HEADER, id);
    await next();
  };
}
