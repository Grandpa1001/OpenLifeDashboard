import { z } from "zod";
import { LOGIN_PASSWORD_MAX_UTF16_UNITS, ownerPasswordSchema } from "./identity.js";

// The security of the account over HTTP (Scope §5.9; Architektura §9.6, §9.7; D43). The sessions of the
// owner: the list with the browser and address each was opened from, the end of one other session, and
// the end of all the others, which asks for a fresh second factor. A session is named by its own id, never
// by its token: the token is a secret of the cookie and is never in an answer.

export const SECURITY_SESSIONS_PATH = "/api/v1/security/sessions";
/** One session: `DELETE` ends it. */
export const SECURITY_SESSION_PATH = `${SECURITY_SESSIONS_PATH}/:id` as const;
export const securitySessionPath = (id: string): string => `${SECURITY_SESSIONS_PATH}/${id}`;
/** `POST` ends every session but the caller's; asks for a fresh second factor. */
export const SECURITY_SESSIONS_REVOKE_OTHERS_PATH = `${SECURITY_SESSIONS_PATH}/revoke-others` as const;

export const SECURITY_DEVICES_PATH = "/api/v1/security/devices";
/** One trusted device: `DELETE` revokes it. */
export const SECURITY_DEVICE_PATH = `${SECURITY_DEVICES_PATH}/:id` as const;
export const securityDevicePath = (id: string): string => `${SECURITY_DEVICES_PATH}/${id}`;
/** `POST` revokes every trusted device; asks for a fresh second factor. */
export const SECURITY_DEVICES_REVOKE_ALL_PATH = `${SECURITY_DEVICES_PATH}/revoke-all` as const;

/** `POST` changes the password: the current one and the new one, with a fresh second factor. */
export const SECURITY_PASSWORD_PATH = "/api/v1/security/password";

/**
 * `POST` makes a new batch of recovery codes, shown once (the answer is the `issuedRecoveryCodesSchema` of
 * the enrollment); needs a fresh second factor. The old codes stop working at once.
 */
export const SECURITY_RECOVERY_CODES_PATH = "/api/v1/security/recovery-codes";

/** `POST` proves the password again; only while the second factor is off, where it is the proof of a sensitive action. */
export const SECURITY_PASSWORD_CONFIRM_PATH = "/api/v1/security/password/confirm";
/** `POST` sets the second factor up again (also after it was turned off); needs a fresh proof; enrollment follows. */
export const SECURITY_MFA_RESTART_PATH = "/api/v1/security/mfa/restart";
/** `POST` turns the second factor off on purpose; needs a fresh TOTP and the explicit acknowledgment of the risk. */
export const SECURITY_MFA_DISABLE_PATH = "/api/v1/security/mfa/disable";

export const SESSION_ASSURANCES = ["password", "totp", "trusted", "recovery"] as const;

export const securitySessionSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** The session that made this request. */
    current: z.boolean(),
    /** How it was admitted: by the password only, a TOTP, a trusted device or a recovery code. */
    assurance: z.enum(SESSION_ASSURANCES),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.iso.datetime(),
    /** The last time a factor was proven in it (the password or a TOTP); not the last request. */
    lastProofAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type SecuritySessionDto = z.infer<typeof securitySessionSchema>;

/** The sessions of the owner, the newest first. */
export const securitySessionListSchema = z.object({ sessions: z.array(securitySessionSchema) }).strict();
export type SecuritySessionListDto = z.infer<typeof securitySessionListSchema>;

/** Ending a session or all the others has nothing to say but the path. */
export const revokeSessionRequestSchema = z.object({}).strict();

export const sessionsRevokedSchema = z.object({ revoked: z.number().int().min(0) }).strict();
export type SessionsRevokedDto = z.infer<typeof sessionsRevokedSchema>;

/** A device the owner trusted: the token and its hash are never in an answer. */
export const trustedDeviceSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** The browser as it called itself when trusted; null for a device trusted before names were kept. */
    label: z.string().min(1).max(200).nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type TrustedDeviceDto = z.infer<typeof trustedDeviceSchema>;

/** The devices that are neither revoked nor expired, the newest first. */
export const trustedDeviceListSchema = z.object({ devices: z.array(trustedDeviceSchema) }).strict();
export type TrustedDeviceListDto = z.infer<typeof trustedDeviceListSchema>;

export const devicesRevokedSchema = z.object({ revoked: z.number().int().min(0) }).strict();
export type DevicesRevokedDto = z.infer<typeof devicesRevokedSchema>;

/**
 * The current password is only bounded in size, like a sign-in: a wrong one is a wrong password, and the
 * answer cannot tell a short guess from a long one. The new one follows the contract of the owner's password.
 */
export const changePasswordRequestSchema = z
  .object({ currentPassword: z.string().min(1).max(LOGIN_PASSWORD_MAX_UTF16_UNITS), newPassword: ownerPasswordSchema })
  .strict();
export type ChangePasswordRequestDto = z.infer<typeof changePasswordRequestSchema>;

/** The caller's session is replaced and keeps working; the others and the trusted devices are gone. */
export const passwordChangedSchema = z.object({ revokedSessions: z.number().int().min(0), revokedDevices: z.number().int().min(0) }).strict();
export type PasswordChangedDto = z.infer<typeof passwordChangedSchema>;

/** Only the size is bounded, like a sign-in: a wrong password is a wrong password. */
export const confirmPasswordRequestSchema = z.object({ password: z.string().min(1).max(LOGIN_PASSWORD_MAX_UTF16_UNITS) }).strict();

/** The owner says in so many words that the account will be protected by the password alone. */
export const disableMfaRequestSchema = z.object({ acknowledgeRisk: z.literal(true) }).strict();

/** What ended with the factor: the other sessions and the trusted devices. */
export const factorChangedSchema = z.object({ revokedSessions: z.number().int().min(0), revokedDevices: z.number().int().min(0) }).strict();
export type FactorChangedDto = z.infer<typeof factorChangedSchema>;

/** After a restart the owner enrolls again; the caller's own session carries on to the enrollment. */
export const factorRestartedSchema = factorChangedSchema.extend({ nextAction: z.literal("mfa_enrollment") }).strict();
export type FactorRestartedDto = z.infer<typeof factorRestartedSchema>;
