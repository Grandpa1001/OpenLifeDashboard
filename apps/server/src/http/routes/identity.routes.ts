// Sign-in, sign-out and status (Architektura §9.8, §18.7; D09.3): the closed list of auth
// routes. Nothing else under /api/auth is mounted, so the library's own endpoints (sign-up,
// session, password reset, token and user updates) answer the API 404. Responses carry no
// token, session row or account data; a session exists only after the unit of work committed.
import { IDENTITY_STATUS_PATH, loginRequestSchema, normalizeOwnerEmail, SIGN_IN_PATH, SIGN_OUT_PATH, type IdentityStatus } from "@openlife/contracts/http/identity";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import { readIdentityStatus, signInWithPassword, signOut, type PasswordVerifier, type SignInPorts } from "@openlife/core/identity";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AttemptKeys } from "../../adapters/auth/attempt-keys.js";
import type { SessionCookies } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { rateLimit, type RateLimiter } from "../middleware/fixed-window-limit.js";
import { requireSameOrigin } from "../middleware/same-origin.js";
import { LOGIN_BODY_MAX_BYTES, USER_AGENT_MAX_LENGTH } from "../security-limits.js";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "../session-cookie-http.js";

export type IdentityRouteDependencies = Readonly<{
  unit: UnitOfWork<SignInPorts> & ReadUnit<SignInPorts>;
  verifier: PasswordVerifier;
  decoyHash: string;
  cookies: SessionCookies;
  keys: AttemptKeys;
  /** Origin of BASE_URL: the only Origin a browser mutation may carry. */
  allowedOrigin: string;
  /** Cookies get `Secure` in HTTPS mode (Architektura §9.4). */
  secureCookies: boolean;
  loginLimiter: RateLimiter;
  /** The peer of the connection; X-Forwarded-For is not read until the trusted proxy exists (§14.4). */
  clientIp: (c: Context<AppEnv>) => string;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  newId: () => string;
  newSessionToken: () => string;
  logger: TechnicalLogger;
}>;

export function registerIdentityRoutes(app: Hono<AppEnv>, deps: IdentityRouteDependencies): void {
  const noStore = (c: Context<AppEnv>): void => c.header("Cache-Control", "no-store");
  const sessionToken = (c: Context<AppEnv>): Promise<string | null> => readSessionToken(c, deps.cookies);
  const unavailable = (c: Context<AppEnv>, error: unknown): Response => {
    deps.logger.log({ level: "error", event: "auth.unavailable", requestId: c.get("requestId"), code: "AUTH_UNAVAILABLE", error });
    noStore(c);
    return apiErrorResponse(c, 503, "AUTH_UNAVAILABLE");
  };

  app.post(
    SIGN_IN_PATH,
    requireSameOrigin(deps.allowedOrigin),
    rateLimit(deps.loginLimiter, deps.clientIp),
    bodyLimit({ maxSize: LOGIN_BODY_MAX_BYTES, onError: (c) => apiErrorResponse(c, 422, "VALIDATION_FAILED") }),
    async (c) => {
      noStore(c);
      const body = loginRequestSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) {
        return apiErrorResponse(c, 422, "VALIDATION_FAILED");
      }
      const email = normalizeOwnerEmail(body.data.email);
      const ip = deps.clientIp(c);
      const userAgent = c.req.header("User-Agent")?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;
      try {
        const outcome = await signInWithPassword(
          {
            unit: deps.unit,
            verifier: deps.verifier,
            decoyHash: deps.decoyHash,
            nowMs: deps.nowMs,
            newSessionId: deps.newId,
            newSessionToken: deps.newSessionToken,
          },
          { email, password: body.data.password, accountKey: deps.keys.account(email), ipKey: deps.keys.ip(ip), ip, userAgent, requestId: c.get("requestId") },
        );
        if (outcome.kind === "locked") {
          c.header("Retry-After", String(outcome.retryAfterSeconds));
          return apiErrorResponse(c, 429, "AUTH_LOCKED", { retryAfterSeconds: outcome.retryAfterSeconds });
        }
        if (outcome.kind === "denied") {
          return apiErrorResponse(c, 401, "INVALID_CREDENTIALS");
        }
        // The session is committed; only now does the browser get its cookie.
        await setSessionCookie(c, deps.cookies, deps.secureCookies, { token: outcome.token, expiresAtMs: outcome.expiresAtMs }, deps.nowMs());
        const status: IdentityStatus = { authenticated: true, nextAction: outcome.nextAction };
        return c.json(status);
      } catch (error) {
        return unavailable(c, error);
      }
    },
  );

  app.post(SIGN_OUT_PATH, requireSameOrigin(deps.allowedOrigin), async (c) => {
    noStore(c);
    try {
      signOut(deps.unit, await sessionToken(c));
    } catch (error) {
      return unavailable(c, error);
    }
    clearSessionCookie(c, deps.cookies, deps.secureCookies);
    return c.body(null, 204);
  });

  app.get(IDENTITY_STATUS_PATH, async (c) => {
    noStore(c);
    try {
      const status: IdentityStatus = readIdentityStatus(deps.unit, await sessionToken(c), deps.nowMs());
      return c.json(status);
    } catch (error) {
      return unavailable(c, error);
    }
  });
}
