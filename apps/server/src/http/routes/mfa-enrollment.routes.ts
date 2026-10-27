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
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import {
  acknowledgeRecovery,
  beginEnrollment,
  confirmEnrollment,
  reissueRecoveryCodes,
  type MfaCrypto,
  type EnrollmentDependencies,
  type EnrollmentPorts,
} from "@openlife/core/identity";
import type { Context, Hono } from "hono";
import type { AttemptKeys } from "../../adapters/auth/attempt-keys.js";
import type { SessionCookies } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { createMfaOperationKit } from "../mfa-operation.js";
import { setSessionCookie } from "../session-cookie-http.js";

export type MfaEnrollmentRouteDependencies = Readonly<{
  unit: UnitOfWork<EnrollmentPorts> & ReadUnit<EnrollmentPorts>;
  crypto: MfaCrypto;
  cookies: SessionCookies;
  allowedOrigin: string;
  secureCookies: boolean;
  /** Keys of the buckets that count the refusals of a factor (D11.3). */
  keys: AttemptKeys;
  /** The peer of the connection; X-Forwarded-For is not read until the trusted proxy exists. */
  clientIp: (c: Context<AppEnv>) => string;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  newId: () => string;
  newSessionToken: () => string;
  logger: TechnicalLogger;
}>;

export function registerMfaEnrollmentRoutes(app: Hono<AppEnv>, deps: MfaEnrollmentRouteDependencies): void {
  const enrollment: EnrollmentDependencies = {
    unit: deps.unit,
    crypto: deps.crypto,
    nowMs: deps.nowMs,
    newId: deps.newId,
    newSessionId: deps.newId,
    newSessionToken: deps.newSessionToken,
    mfaAccountKey: deps.keys.mfaAccount,
  };
  /** Who is asking, for the audit and for the bucket of the client address. */
  const attemptOf = (c: Context<AppEnv>) => ({ requestId: c.get("requestId"), ipKey: deps.keys.mfaIp(deps.clientIp(c)) });
  const { guard, operation, refused } = createMfaOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

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
        return refused(c, result.error);
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
      const result = await confirmEnrollment(enrollment, token, body, attemptOf(c));
      return result.ok ? issued(c, result.value) : refused(c, result.error);
    }),
  );

  app.post(
    MFA_RECOVERY_REISSUE_PATH,
    ...guard,
    operation(reissueRecoveryRequestSchema, async (c, token, body) => {
      const result = await reissueRecoveryCodes(enrollment, token, body, attemptOf(c));
      return result.ok ? issued(c, result.value) : refused(c, result.error);
    }),
  );

  app.post(
    MFA_RECOVERY_ACK_PATH,
    ...guard,
    operation(acknowledgeRecoveryRequestSchema, async (c, token, body) => {
      const result = acknowledgeRecovery(enrollment, token, body, c.get("requestId"));
      return result.ok ? c.json(result.value) : refused(c, result.error);
    }),
  );
}
