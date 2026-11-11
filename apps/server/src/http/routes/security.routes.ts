// The security of the account over HTTP (Scope §5.9; Architektura §9.6, §9.7; D43.1): the sessions of the
// owner. The list and the end of one other session are private data of the owner; ending all the others
// asks for a fresh second factor, so without one the answer is `STEP_UP_REQUIRED` and nothing is ended.
// An answer names a session by its id and never carries a token. Nothing is cached.
import {
  revokeSessionRequestSchema,
  SECURITY_SESSIONS_PATH,
  SECURITY_SESSION_PATH,
  SECURITY_SESSIONS_REVOKE_OTHERS_PATH,
  type SecuritySessionListDto,
  type SessionsRevokedDto,
} from "@openlife/contracts/http/security";
import { listOwnerSessions, revokeOtherSessions, revokeOwnerSession, type SessionManagementDependencies } from "@openlife/core/identity";
import type { Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";

export type SecurityRouteDependencies = Readonly<{
  unit: SessionManagementDependencies["unit"];
  cookies: SignedCookie;
  allowedOrigin: string;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerSecurityRoutes(app: Hono<AppEnv>, deps: SecurityRouteDependencies): void {
  const sessions: SessionManagementDependencies = { unit: deps.unit, nowMs: deps.nowMs };
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  app.get(
    SECURITY_SESSIONS_PATH,
    read((c, token) => {
      const result = listOwnerSessions(sessions, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: SecuritySessionListDto = {
        sessions: result.value.map((session) => ({
          id: session.sessionId,
          current: session.current,
          assurance: session.assurance,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          createdAt: new Date(session.createdAtMs).toISOString(),
          lastProofAt: new Date(session.lastProofAtMs).toISOString(),
          expiresAt: new Date(session.expiresAtMs).toISOString(),
        })),
      };
      return c.json(dto);
    }),
  );

  app.post(
    SECURITY_SESSIONS_REVOKE_OTHERS_PATH,
    ...guard,
    operation(revokeSessionRequestSchema, async (c, token) => {
      const result = revokeOtherSessions(sessions, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: SessionsRevokedDto = { revoked: result.value.revoked };
      return c.json(dto);
    }),
  );

  app.delete(
    SECURITY_SESSION_PATH,
    ...guard,
    operation(revokeSessionRequestSchema, async (c, token) => {
      const result = revokeOwnerSession(sessions, token, c.req.param("id") ?? "", c.get("requestId"));
      return result.ok ? c.body(null, 204) : refused(c, result.error);
    }),
  );
}
