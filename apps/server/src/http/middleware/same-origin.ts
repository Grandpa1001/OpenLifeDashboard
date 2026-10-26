import type { MiddlewareHandler } from "hono";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";

/**
 * Browser mutations must carry an Origin equal to the installation's BASE_URL, port included
 * (Architektura §9.8). A missing, "null" or foreign Origin is refused before the handler reads
 * the body, so no credential is tried and nothing is counted. Safe methods are not checked.
 */
export function requireSameOrigin(allowedOrigin: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.header("Origin") !== allowedOrigin) {
      return apiErrorResponse(c, 403, "ORIGIN_FORBIDDEN");
    }
    await next();
    return undefined;
  };
}
