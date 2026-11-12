// Calls of the security of the account (Scope §5.9; D43) as typed results. A call that needs a fresh second
// factor answers `STEP_UP_REQUIRED`; the page asks for the proof (`components/step-up.tsx`) and calls again.
import { MFA_STEP_UP_PATH, stepUpRequestSchema } from "@openlife/contracts/http/mfa";
import {
  auditLogSchema,
  confirmPasswordRequestSchema,
  factorStatusSchema,
  SECURITY_AUDIT_PATH,
  SECURITY_DEVICES_PATH,
  SECURITY_DEVICES_REVOKE_ALL_PATH,
  SECURITY_FACTOR_PATH,
  SECURITY_PASSWORD_CONFIRM_PATH,
  SECURITY_SESSIONS_PATH,
  SECURITY_SESSIONS_REVOKE_OTHERS_PATH,
  devicesRevokedSchema,
  securityDevicePath,
  securitySessionListSchema,
  securitySessionPath,
  sessionsRevokedSchema,
  trustedDeviceListSchema,
  type AuditQueryDto,
} from "@openlife/contracts/http/security";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchSessions = (signal?: AbortSignal) => apiRequest({ method: "GET", path: SECURITY_SESSIONS_PATH, schema: securitySessionListSchema, signal });
export const revokeSession = (id: string) => apiRequest({ method: "DELETE", path: securitySessionPath(id), body: {}, schema: null });
export const revokeOtherSessions = () => apiRequest({ method: "POST", path: SECURITY_SESSIONS_REVOKE_OTHERS_PATH, body: {}, schema: sessionsRevokedSchema });

export const fetchDevices = (signal?: AbortSignal) => apiRequest({ method: "GET", path: SECURITY_DEVICES_PATH, schema: trustedDeviceListSchema, signal });
export const revokeDevice = (id: string) => apiRequest({ method: "DELETE", path: securityDevicePath(id), body: {}, schema: null });
export const revokeAllDevices = () => apiRequest({ method: "POST", path: SECURITY_DEVICES_REVOKE_ALL_PATH, body: {}, schema: devicesRevokedSchema });

export const fetchFactor = (signal?: AbortSignal) => apiRequest({ method: "GET", path: SECURITY_FACTOR_PATH, schema: factorStatusSchema, signal });

export function fetchAudit(query: Readonly<{ kind?: AuditQueryDto["kind"]; page: number }>, signal?: AbortSignal) {
  const params = new URLSearchParams({ page: String(query.page), ...(query.kind === undefined ? {} : { kind: query.kind }) });
  return apiRequest({ method: "GET", path: `${SECURITY_AUDIT_PATH}?${params.toString()}`, schema: auditLogSchema, signal });
}

/** The proof of a sensitive action: a fresh TOTP while the factor is in force, the password once it is off. The answers replace the session's cookie. */
export const proveWithCode = (code: string) => apiRequest({ method: "POST", path: MFA_STEP_UP_PATH, body: stepUpRequestSchema.parse({ code }), schema: null });
export const proveWithPassword = (password: string) => apiRequest({ method: "POST", path: SECURITY_PASSWORD_CONFIRM_PATH, body: confirmPasswordRequestSchema.parse({ password }), schema: null });
