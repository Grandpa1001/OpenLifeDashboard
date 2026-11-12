// The security of the account over HTTP (Scope §5.9; Architektura §9.6, §9.7; D43.1): the sessions of the
// owner. The list and the end of one other session are private data of the owner; ending all the others
// asks for a fresh second factor, so without one the answer is `STEP_UP_REQUIRED` and nothing is ended.
// An answer names a session by its id and never carries a token. Nothing is cached.
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import {
  auditLogSchema,
  auditQuerySchema,
  changePasswordRequestSchema,
  confirmPasswordRequestSchema,
  disableMfaRequestSchema,
  factorChangedSchema,
  factorStatusSchema,
  factorRestartedSchema,
  SECURITY_MFA_DISABLE_PATH,
  SECURITY_MFA_RESTART_PATH,
  SECURITY_PASSWORD_CONFIRM_PATH,
  passwordChangedSchema,
  revokeSessionRequestSchema,
  SECURITY_AUDIT_PATH,
  SECURITY_FACTOR_PATH,
  SECURITY_PASSWORD_PATH,
  SECURITY_RECOVERY_CODES_PATH,
  SECURITY_DEVICE_PATH,
  SECURITY_DEVICES_PATH,
  SECURITY_DEVICES_REVOKE_ALL_PATH,
  type DevicesRevokedDto,
  type TrustedDeviceListDto,
  SECURITY_SESSIONS_PATH,
  SECURITY_SESSION_PATH,
  SECURITY_SESSIONS_REVOKE_OTHERS_PATH,
  type SecuritySessionListDto,
  type SessionsRevokedDto,
} from "@openlife/contracts/http/security";
import {
  changeOwnerPassword,
  confirmOwnerPassword,
  disableSecondFactor,
  readAuditLog,
  readFactorStatus,
  restartSecondFactor,
  regenerateRecoveryCodes,
  listOwnerSessions,
  listTrustedDevices,
  revokeAllTrustedDevices,
  revokeOtherSessions,
  revokeOwnerSession,
  revokeTrustedDevice,
  type ChangePasswordDependencies,
  type AuditLogDependencies,
  type FactorStatusDependencies,
  type ConfirmPasswordDependencies,
  type FactorManagementDependencies,
  type DeviceManagementDependencies,
  type RegenerateRecoveryDependencies,
  type SessionManagementDependencies,
} from "@openlife/core/identity";
import type { Context, Hono } from "hono";
import type { AttemptKeys } from "../../adapters/auth/attempt-keys.js";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { createSessionOperationKit } from "../session-operation.js";
import { setSessionCookie } from "../session-cookie-http.js";

export type SecurityRouteDependencies = Readonly<{
  unit: SessionManagementDependencies["unit"] & DeviceManagementDependencies["unit"] & ChangePasswordDependencies["unit"] & RegenerateRecoveryDependencies["unit"] & FactorManagementDependencies["unit"] & ConfirmPasswordDependencies["unit"] & AuditLogDependencies["unit"] & FactorStatusDependencies["unit"];
  cookies: SignedCookie;
  allowedOrigin: string;
  secureCookies: boolean;
  /** The shared hasher of the password: the current one is verified and the new one hashed outside a unit of work. */
  hasher: ChangePasswordDependencies["hasher"];
  /** The generator of recovery codes and their hashes. */
  crypto: RegenerateRecoveryDependencies["crypto"];
  /** Keys of the buckets of the password: a wrong current password counts like a wrong password at sign-in. */
  keys: AttemptKeys;
  /** The peer of the connection; X-Forwarded-For is not read until the trusted proxy exists. */
  clientIp: (c: Context<AppEnv>) => string;
  newId: () => string;
  newSessionToken: () => string;
  /** Wall clock in milliseconds. */
  nowMs: () => number;
  logger: TechnicalLogger;
}>;

export function registerSecurityRoutes(app: Hono<AppEnv>, deps: SecurityRouteDependencies): void {
  const sessions: SessionManagementDependencies = { unit: deps.unit, nowMs: deps.nowMs };
  const devices: DeviceManagementDependencies = { unit: deps.unit, nowMs: deps.nowMs };
  const recovery: RegenerateRecoveryDependencies = { unit: deps.unit, crypto: deps.crypto, nowMs: deps.nowMs, newId: deps.newId };
  const factorStatus: FactorStatusDependencies = { unit: deps.unit, nowMs: deps.nowMs };
  const trail: AuditLogDependencies = { unit: deps.unit, nowMs: deps.nowMs };
  const factor: FactorManagementDependencies = { unit: deps.unit, nowMs: deps.nowMs, newSessionId: deps.newId, newSessionToken: deps.newSessionToken };
  const confirmation: ConfirmPasswordDependencies = {
    unit: deps.unit,
    verifier: deps.hasher,
    nowMs: deps.nowMs,
    newSessionId: deps.newId,
    newSessionToken: deps.newSessionToken,
    keysOf: (email, ipKey) => ({ account: deps.keys.account(email), ip: ipKey }),
  };
  const passwords: ChangePasswordDependencies = {
    unit: deps.unit,
    hasher: deps.hasher,
    nowMs: deps.nowMs,
    newSessionId: deps.newId,
    newSessionToken: deps.newSessionToken,
    keysOf: (email, ipKey) => ({ account: deps.keys.account(email), ip: ipKey }),
  };
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

  app.get(
    SECURITY_DEVICES_PATH,
    read((c, token) => {
      const result = listTrustedDevices(devices, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: TrustedDeviceListDto = {
        devices: result.value.map((device) => ({
          id: device.deviceId,
          label: device.label,
          createdAt: new Date(device.createdAtMs).toISOString(),
          expiresAt: new Date(device.expiresAtMs).toISOString(),
        })),
      };
      return c.json(dto);
    }),
  );

  app.post(
    SECURITY_DEVICES_REVOKE_ALL_PATH,
    ...guard,
    operation(revokeSessionRequestSchema, async (c, token) => {
      const result = revokeAllTrustedDevices(devices, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      const dto: DevicesRevokedDto = { revoked: result.value.revoked };
      return c.json(dto);
    }),
  );

  app.delete(
    SECURITY_DEVICE_PATH,
    ...guard,
    operation(revokeSessionRequestSchema, async (c, token) => {
      const result = revokeTrustedDevice(devices, token, c.req.param("id") ?? "", c.get("requestId"));
      return result.ok ? c.body(null, 204) : refused(c, result.error);
    }),
  );

  app.post(
    SECURITY_PASSWORD_PATH,
    ...guard,
    operation(changePasswordRequestSchema, async (c, token, body) => {
      const result = await changeOwnerPassword(passwords, token, body, { requestId: c.get("requestId"), ipKey: deps.keys.ip(deps.clientIp(c)) });
      if (!result.ok) return refused(c, result.error);
      // The change has committed: only now does the browser get the cookie of the session that replaces its own.
      await setSessionCookie(c, deps.cookies, deps.secureCookies, { token: result.value.token, expiresAtMs: result.value.expiresAtMs }, deps.nowMs());
      return c.json(passwordChangedSchema.parse({ revokedSessions: result.value.revokedSessions, revokedDevices: result.value.revokedDevices }));
    }),
  );

  app.post(
    SECURITY_RECOVERY_CODES_PATH,
    ...guard,
    operation(revokeSessionRequestSchema, async (c, token) => {
      const result = regenerateRecoveryCodes(recovery, token, c.get("requestId"));
      return result.ok ? c.json(issuedRecoveryCodesSchema.parse(result.value)) : refused(c, result.error);
    }),
  );

  app.post(
    SECURITY_PASSWORD_CONFIRM_PATH,
    ...guard,
    operation(confirmPasswordRequestSchema, async (c, token, body) => {
      const result = await confirmOwnerPassword(confirmation, token, body.password, { requestId: c.get("requestId"), ipKey: deps.keys.ip(deps.clientIp(c)) });
      if (!result.ok) return refused(c, result.error);
      await setSessionCookie(c, deps.cookies, deps.secureCookies, { token: result.value.token, expiresAtMs: result.value.expiresAtMs }, deps.nowMs());
      return c.body(null, 204);
    }),
  );

  app.post(
    SECURITY_MFA_RESTART_PATH,
    ...guard,
    operation(revokeSessionRequestSchema, async (c, token) => {
      const result = restartSecondFactor(factor, token, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      // The restart has committed: only now does the browser get the cookie of the session that replaces its own.
      await setSessionCookie(c, deps.cookies, deps.secureCookies, { token: result.value.token, expiresAtMs: result.value.expiresAtMs }, deps.nowMs());
      return c.json(factorRestartedSchema.parse({ revokedSessions: result.value.revokedSessions, revokedDevices: result.value.revokedDevices, nextAction: "mfa_enrollment" }));
    }),
  );

  app.post(
    SECURITY_MFA_DISABLE_PATH,
    ...guard,
    operation(disableMfaRequestSchema, async (c, token) => {
      const result = disableSecondFactor(factor, token, c.get("requestId"));
      return result.ok ? c.json(factorChangedSchema.parse(result.value)) : refused(c, result.error);
    }),
  );

  app.get(
    SECURITY_AUDIT_PATH,
    read((c, token) => {
      // A field given twice is not one of the contract's: it is refused, not read as its first value.
      const given = c.req.queries();
      const query = auditQuerySchema.safeParse(Object.fromEntries(Object.entries(given).map(([field, values]) => [field, values.length === 1 ? values[0] : values])));
      if (!query.success) return apiErrorResponse(c, 422, "VALIDATION_FAILED");
      const result = readAuditLog(trail, token, { page: query.data.page, ...(query.data.kind === undefined ? {} : { kind: query.data.kind }) }, c.get("requestId"));
      return result.ok ? c.json(auditLogSchema.parse(result.value)) : refused(c, result.error);
    }),
  );

  app.get(
    SECURITY_FACTOR_PATH,
    read((c, token) => {
      const result = readFactorStatus(factorStatus, token, c.get("requestId"));
      return result.ok ? c.json(factorStatusSchema.parse(result.value)) : refused(c, result.error);
    }),
  );
}
