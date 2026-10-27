// Proving the second factor over HTTP (Architektura §9.7, §18.7; D11.2): `POST /api/v1/mfa/verify`
// (a TOTP or a recovery code) and `POST /api/v1/mfa/step-up` (a TOTP). A proof ends the caller's
// session and the answer carries the cookie of the new one, set only after its unit committed; a
// trusted-device cookie is set only when the owner asked for it with a TOTP. An error in a unit
// is a 503 with no cookie at all.
import { MFA_STEP_UP_PATH, MFA_VERIFY_PATH, stepUpRequestSchema, verifyRequestSchema, type MfaVerifiedDto } from "@openlife/contracts/http/mfa";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import { stepUp, verifyRecoveryCode, verifyTotp, type MfaCrypto, type MfaProof, type VerificationDependencies, type VerificationPorts } from "@openlife/core/identity";
import type { Context, Hono } from "hono";
import type { AttemptKeys } from "../../adapters/auth/attempt-keys.js";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";
import { setSessionCookie } from "../session-cookie-http.js";

export type MfaVerificationRouteDependencies = Readonly<{
  unit: UnitOfWork<VerificationPorts> & ReadUnit<VerificationPorts>;
  crypto: MfaCrypto;
  cookies: SignedCookie;
  trustedDeviceCookies: SignedCookie;
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

export function registerMfaVerificationRoutes(app: Hono<AppEnv>, deps: MfaVerificationRouteDependencies): void {
  const verification: VerificationDependencies = {
    unit: deps.unit,
    crypto: deps.crypto,
    nowMs: deps.nowMs,
    newId: deps.newId,
    newSessionToken: deps.newSessionToken,
    mfaAccountKey: deps.keys.mfaAccount,
  };
  /** Who is asking, for the audit and for the bucket of the client address. */
  const attemptOf = (c: Context<AppEnv>) => ({ requestId: c.get("requestId"), ipKey: deps.keys.mfaIp(deps.clientIp(c)) });
  const { guard, operation, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger });

  /** The unit has committed: only now do the cookies of the proof reach the browser. */
  const proven = async (c: Context<AppEnv>, proof: MfaProof): Promise<Response> => {
    await setSessionCookie(c, deps.cookies, deps.secureCookies, proof, deps.nowMs());
    if (proof.trustedDevice !== null) {
      await setSessionCookie(c, deps.trustedDeviceCookies, deps.secureCookies, proof.trustedDevice, deps.nowMs());
    }
    const dto: MfaVerifiedDto = { nextAction: proof.nextAction, ...(proof.remainingRecoveryCodes === null ? {} : { remainingRecoveryCodes: proof.remainingRecoveryCodes }) };
    return c.json(dto);
  };

  app.post(
    MFA_VERIFY_PATH,
    ...guard,
    operation(verifyRequestSchema, async (c, token, body) => {
      const attempt = attemptOf(c);
      const result =
        "recoveryCode" in body
          ? verifyRecoveryCode(verification, token, body, attempt)
          : await verifyTotp(verification, token, { code: body.code, rememberDevice: body.rememberDevice ?? false }, attempt);
      return result.ok ? proven(c, result.value) : refused(c, result.error);
    }),
  );

  app.post(
    MFA_STEP_UP_PATH,
    ...guard,
    operation(stepUpRequestSchema, async (c, token, body) => {
      const result = await stepUp(verification, token, body, attemptOf(c));
      return result.ok ? proven(c, result.value) : refused(c, result.error);
    }),
  );
}
