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
