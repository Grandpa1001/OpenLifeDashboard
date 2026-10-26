// Enrollment of the second factor over HTTP (Architektura §9.7, §18.7; D11.1): the four explicit
// operations. Each is a browser mutation (Origin must match), answers no-store and needs a live
// session; what the session may do is decided by the use cases of core/identity. A new session
// (after confirm or reissue) reaches the browser as a cookie only after its unit committed; an
// error inside a unit, a failing audit included, is a 503 with no cookie and no codes.
import {
  acknowledgeRecoveryRequestSchema,
  beginEnrollmentRequestSchema,
  confirmEnrollmentRequestSchema,
  MFA_ENROLLMENT_BEGIN_PATH,
  MFA_ENROLLMENT_CONFIRM_PATH,
  MFA_RECOVERY_ACK_PATH,
  MFA_RECOVERY_REISSUE_PATH,
  reissueRecoveryRequestSchema,
  type EnrollmentChallengeDto,
  type IssuedRecoveryCodesDto,
} from "@openlife/contracts/http/mfa";
import type { ApiErrorCode } from "@openlife/contracts/http/errors";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import {
  acknowledgeRecovery,
  beginEnrollment,
  confirmEnrollment,
  reissueRecoveryCodes,
  type EnrollmentCrypto,
  type EnrollmentDependencies,
  type EnrollmentPorts,
} from "@openlife/core/identity";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { SessionCookies } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { requireSameOrigin } from "../middleware/same-origin.js";
import { readSessionToken, setSessionCookie } from "../session-cookie-http.js";

/** An enrollment request is a few short fields; more is refused before it is read. */
const BODY_MAX_BYTES = 1024;

export type MfaEnrollmentRouteDependencies = Readonly<{
  unit: UnitOfWork<EnrollmentPorts> & ReadUnit<EnrollmentPorts>;
  crypto: EnrollmentCrypto;
  cookies: SessionCookies;
  allowedOrigin: string;
  secureCookies: boolean;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  newId: () => string;
  newSessionToken: () => string;
  logger: TechnicalLogger;
}>;

const STATUS: Readonly<Partial<Record<ApiErrorCode, 401 | 409>>> = {
  AUTH_REQUIRED: 401,
  MFA_INVALID_CODE: 401,
  ENROLLMENT_CHANGED: 409,
  RECOVERY_BATCH_CHANGED: 409,
};

export function registerMfaEnrollmentRoutes(app: Hono<AppEnv>, deps: MfaEnrollmentRouteDependencies): void {
  const enrollment: EnrollmentDependencies = {
    unit: deps.unit,
    crypto: deps.crypto,
    nowMs: deps.nowMs,
    newId: deps.newId,
    newSessionId: deps.newId,
    newSessionToken: deps.newSessionToken,
  };
  const guard = [
    requireSameOrigin(deps.allowedOrigin),
    bodyLimit({ maxSize: BODY_MAX_BYTES, onError: (c: Context<AppEnv>) => apiErrorResponse(c, 422, "VALIDATION_FAILED") }),
  ] as const;

  /** Common frame: no-store, a valid body, a verified session cookie, and errors that are not answers. */
  const operation = <S extends z.ZodType>(schema: S, run: (c: Context<AppEnv>, token: string, body: z.infer<S>) => Promise<Response>) =>
    async (c: Context<AppEnv>): Promise<Response> => {
      c.header("Cache-Control", "no-store");
      const body = schema.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) {
        return apiErrorResponse(c, 422, "VALIDATION_FAILED");
      }
      const token = await readSessionToken(c, deps.cookies);
      if (token === null) {
        return apiErrorResponse(c, 401, "AUTH_REQUIRED");
      }
      try {
        return await run(c, token, body.data);
      } catch (error) {
        deps.logger.log({ level: "error", event: "mfa.unavailable", requestId: c.get("requestId"), code: "AUTH_UNAVAILABLE", error });
        return apiErrorResponse(c, 503, "AUTH_UNAVAILABLE");
      }
    };

  const refused = (c: Context<AppEnv>, code: string): Response => {
    const known = code as ApiErrorCode;
    return apiErrorResponse(c, STATUS[known] ?? 409, known);
  };

  const issued = async (
    c: Context<AppEnv>,
    outcome: Readonly<{ token: string; expiresAtMs: number; batchId: string; recoveryCodes: readonly string[]; nextAction: IssuedRecoveryCodesDto["nextAction"] }>,
  ): Promise<Response> => {
    // The unit has committed; only now does the browser get the cookie of the promoted session.
    await setSessionCookie(c, deps.cookies, deps.secureCookies, outcome, deps.nowMs());
    const dto: IssuedRecoveryCodesDto = { batchId: outcome.batchId, recoveryCodes: [...outcome.recoveryCodes], nextAction: outcome.nextAction };
    return c.json(dto);
  };

  app.post(
    MFA_ENROLLMENT_BEGIN_PATH,
    ...guard,
    operation(beginEnrollmentRequestSchema, async (c, token) => {
      const result = await beginEnrollment(enrollment, token, c.get("requestId"));
      if (!result.ok) {
        return refused(c, result.error.code);
      }
      const dto: EnrollmentChallengeDto = {
        challengeId: result.value.challengeId,
        otpauthUri: result.value.otpauthUri,
        manualKey: result.value.manualKey,
        expiresAt: new Date(result.value.expiresAtMs).toISOString(),
      };
      return c.json(dto);
    }),
  );

  app.post(
    MFA_ENROLLMENT_CONFIRM_PATH,
    ...guard,
    operation(confirmEnrollmentRequestSchema, async (c, token, body) => {
      const result = await confirmEnrollment(enrollment, token, body, c.get("requestId"));
      return result.ok ? issued(c, result.value) : refused(c, result.error.code);
    }),
  );

  app.post(
    MFA_RECOVERY_REISSUE_PATH,
    ...guard,
    operation(reissueRecoveryRequestSchema, async (c, token, body) => {
      const result = await reissueRecoveryCodes(enrollment, token, body, c.get("requestId"));
      return result.ok ? issued(c, result.value) : refused(c, result.error.code);
    }),
  );

  app.post(
    MFA_RECOVERY_ACK_PATH,
    ...guard,
    operation(acknowledgeRecoveryRequestSchema, async (c, token, body) => {
      const result = acknowledgeRecovery(enrollment, token, body, c.get("requestId"));
      return result.ok ? c.json(result.value) : refused(c, result.error.code);
    }),
  );
}
