import { z } from "zod";

// Owner credentials (Architektura §9.3, §9.8): one contract for the login body and for the
// create-owner/reset-password CLI, so both accept and refuse the same values.

export const PASSWORD_MIN_CODE_POINTS = 12;
export const PASSWORD_MAX_CODE_POINTS = 128;
/** Bound on the e-mail before any lookup or hashing of the login key. */
export const OWNER_EMAIL_MAX_LENGTH = 254;

/** Trimmed and lower-cased; the same key in the CLI and at login. */
export function normalizeOwnerEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Length in Unicode code points, not UTF-16 units: an emoji counts once. The password itself is
 * never trimmed or normalized, so "ﬁ" and "fi" stay different passwords.
 */
export function passwordCodePoints(password: string): number {
  return Array.from(password).length;
}

export const ownerPasswordSchema = z
  .string()
  .refine((password) => passwordCodePoints(password) >= PASSWORD_MIN_CODE_POINTS, { message: "too_short" })
  .refine((password) => passwordCodePoints(password) <= PASSWORD_MAX_CODE_POINTS, { message: "too_long" });

export const ownerEmailSchema = z
  .string()
  .transform(normalizeOwnerEmail)
  .pipe(z.email().max(OWNER_EMAIL_MAX_LENGTH));

export const ownerCredentialsSchema = z.object({ email: ownerEmailSchema, password: ownerPasswordSchema }).strict();

export type OwnerCredentials = z.infer<typeof ownerCredentialsSchema>;

/** stdin of the reset-password CLI: the owner is the installation's single owner, so only the new password. */
export const resetPasswordInputSchema = z.object({ password: ownerPasswordSchema }).strict();

export type ResetPasswordInput = z.infer<typeof resetPasswordInputSchema>;

// Sign-in, sign-out and status (Architektura §9.8, §18.7; D09.3): the closed list of the
// operations of the first cross-section. No response carries a token, session or account row.

export const SIGN_IN_PATH = "/api/auth/sign-in/email";
export const SIGN_OUT_PATH = "/api/auth/sign-out";
export const IDENTITY_STATUS_PATH = "/api/v1/identity/status";

/**
 * The login body. A password outside the length contract is not a validation error: it is just
 * a wrong password, so the answer cannot tell a short guess from an incorrect long one. Only the
 * size is bounded, before anything is hashed.
 */
export const LOGIN_PASSWORD_MAX_UTF16_UNITS = PASSWORD_MAX_CODE_POINTS * 2;
export const loginRequestSchema = z
  .object({
    email: z.string().max(OWNER_EMAIL_MAX_LENGTH),
    password: z.string().min(1).max(LOGIN_PASSWORD_MAX_UTF16_UNITS),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * What the browser does next, decided by the one access policy of core/identity (Architektura
 * §9.7). `ready` means the data may be opened; it is not a statement about step-up.
 */
export const NEXT_ACTIONS = ["create_owner", "login", "mfa_enrollment", "mfa_challenge", "recovery_ack", "setup_data", "ready"] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export const identityStatusSchema = z.object({ authenticated: z.boolean(), nextAction: z.enum(NEXT_ACTIONS) }).strict();
export type IdentityStatus = z.infer<typeof identityStatusSchema>;

/** `details` of AUTH_LOCKED; the same for the owner's e-mail and a foreign one. */
export const authLockedDetailsSchema = z.object({ retryAfterSeconds: z.number().int().positive() }).strict();
