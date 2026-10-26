import { z } from "zod";
import { NEXT_ACTIONS } from "./identity.js";

// Enrolling the second factor (Architektura §9.7, §18.7; D11.1): the four explicit operations
// and their DTOs. A challenge or batch identifier is not a permission; the session is. The plain
// recovery codes appear only in the response of confirm and reissue and are never stored.

export const MFA_ENROLLMENT_BEGIN_PATH = "/api/v1/mfa/enrollment/begin";
export const MFA_ENROLLMENT_CONFIRM_PATH = "/api/v1/mfa/enrollment/confirm";
export const MFA_RECOVERY_REISSUE_PATH = "/api/v1/mfa/enrollment/recovery/reissue";
export const MFA_RECOVERY_ACK_PATH = "/api/v1/mfa/enrollment/recovery/ack";
export const MFA_VERIFY_PATH = "/api/v1/mfa/verify";
export const MFA_STEP_UP_PATH = "/api/v1/mfa/step-up";

/** A TOTP code as the authenticator app shows it. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);
const identifierSchema = z.string().min(1).max(64);

export const beginEnrollmentRequestSchema = z.object({}).strict();
export const confirmEnrollmentRequestSchema = z.object({ challengeId: identifierSchema, code: totpCodeSchema }).strict();
export const reissueRecoveryRequestSchema = z.object({ code: totpCodeSchema }).strict();
export const acknowledgeRecoveryRequestSchema = z.object({ batchId: identifierSchema }).strict();

/**
 * A TOTP (which the owner may ask to remember on this device) or a recovery code; never both.
 * A recovery code is typed by hand, so its spelling is free within a size bound.
 */
export const verifyRequestSchema = z.union([
  z.object({ code: totpCodeSchema, rememberDevice: z.boolean().optional() }).strict(),
  z.object({ recoveryCode: z.string().min(1).max(32) }).strict(),
]);
export const stepUpRequestSchema = z.object({ code: totpCodeSchema }).strict();

export const mfaVerifiedSchema = z
  .object({
    nextAction: z.enum(NEXT_ACTIONS),
    /** After a recovery code only: how many are left. */
    remainingRecoveryCodes: z.number().int().min(0).optional(),
  })
  .strict();
export type MfaVerifiedDto = z.infer<typeof mfaVerifiedSchema>;

export const enrollmentChallengeSchema = z
  .object({
    challengeId: z.string(),
    otpauthUri: z.string().startsWith("otpauth://totp/"),
    /** The key for typing it into an authenticator app by hand. */
    manualKey: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type EnrollmentChallengeDto = z.infer<typeof enrollmentChallengeSchema>;

export const RECOVERY_CODES_PER_BATCH = 10;

export const issuedRecoveryCodesSchema = z
  .object({
    batchId: z.string(),
    recoveryCodes: z.array(z.string().regex(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/)).length(RECOVERY_CODES_PER_BATCH),
    nextAction: z.enum(NEXT_ACTIONS),
  })
  .strict();
export type IssuedRecoveryCodesDto = z.infer<typeof issuedRecoveryCodesSchema>;

export const enrollmentStatusSchema = z.object({ nextAction: z.enum(NEXT_ACTIONS) }).strict();
