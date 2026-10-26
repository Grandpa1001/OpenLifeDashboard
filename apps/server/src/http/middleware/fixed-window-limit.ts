import type { MiddlewareHandler } from "hono";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";

export type RateLimiter = Readonly<{
  /** Counts one request of `key`; the seconds to wait when the limit is exceeded. */
  hit: (key: string) => Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;
}>;

const SWEEP_THRESHOLD = 1024;

/** In-memory fixed windows. Restarting the process resets them; persistent lockout is separate. */
export function createRateLimiter(options: Readonly<{ limit: number; windowMs: number; nowMs: () => number }>): RateLimiter {
  const windows = new Map<string, { startedAtMs: number; count: number }>();
  return {
    hit: (key) => {
      const now = options.nowMs();
      if (windows.size > SWEEP_THRESHOLD) {
        for (const [each, window] of windows) {
          if (now - window.startedAtMs >= options.windowMs) {
            windows.delete(each);
          }
        }
      }
      const current = windows.get(key);
      const window = current === undefined || now - current.startedAtMs >= options.windowMs ? { startedAtMs: now, count: 0 } : current;
      window.count += 1;
      windows.set(key, window);
      return window.count <= options.limit
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.startedAtMs + options.windowMs - now) / 1000)) };
    },
  };
}

/** Answers 429 RATE_LIMITED with Retry-After once a client exceeds the limit. */
export function rateLimit(limiter: RateLimiter, clientKey: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const verdict = limiter.hit(clientKey(c));
    if (!verdict.allowed) {
      c.header("Retry-After", String(verdict.retryAfterSeconds));
      return apiErrorResponse(c, 429, "RATE_LIMITED");
    }
    await next();
    return undefined;
  };
}
