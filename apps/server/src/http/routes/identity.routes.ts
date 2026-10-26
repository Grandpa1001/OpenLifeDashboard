// Sign-in, sign-out and status (Architektura §9.8, §18.7; D09.3): the closed list of auth
// routes. Nothing else under /api/auth is mounted, so the library's own endpoints (sign-up,
// session, password reset, token and user updates) answer the API 404. Responses carry no
// token, session row or account data; a session exists only after the unit of work committed.
import { IDENTITY_STATUS_PATH, loginRequestSchema, normalizeOwnerEmail, SIGN_IN_PATH, SIGN_OUT_PATH, type IdentityStatus } from "@openlife/contracts/http/identity";
import type { UnitOfWork } from "@openlife/core/foundation";
import { readIdentityStatus, signInWithPassword, signOut, type PasswordVerifier, type SignInPorts } from "@openlife/core/identity";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AttemptKeys } from "../../adapters/auth/attempt-keys.js";
import type { SessionCookies } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { rateLimit, type RateLimiter } from "../middleware/fixed-window-limit.js";
import { requireSameOrigin } from "../middleware/same-origin.js";
import { LOGIN_BODY_MAX_BYTES, USER_AGENT_MAX_LENGTH } from "../security-limits.js";

export type IdentityRouteDependencies = Readonly<{
  unit: UnitOfWork<SignInPorts>;
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

const cookieAttributes = (secure: boolean) => ({ httpOnly: true, sameSite: "Lax", path: "/", secure }) as const;

export function registerIdentityRoutes(app: Hono<AppEnv>, deps: IdentityRouteDependencies): void {
  const noStore = (c: Context<AppEnv>): void => c.header("Cache-Control", "no-store");
  const sessionToken = async (c: Context<AppEnv>): Promise<string | null> => deps.cookies.verify(getCookie(c, deps.cookies.name));
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
        setCookie(c, deps.cookies.name, await deps.cookies.sign(outcome.token), {
          ...cookieAttributes(deps.secureCookies),
          expires: new Date(outcome.expiresAtMs),
          maxAge: Math.floor((outcome.expiresAtMs - deps.nowMs()) / 1000),
        });
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
    deleteCookie(c, deps.cookies.name, cookieAttributes(deps.secureCookies));
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
