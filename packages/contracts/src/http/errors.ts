import { z } from "zod";

/** Stable API error codes; clients translate them (Architektura §6, §7.6). */
export const API_ERROR_CODES = [
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "VALIDATION_FAILED",
  "ORIGIN_FORBIDDEN",
  "INVALID_CREDENTIALS",
  "AUTH_LOCKED",
  "RATE_LIMITED",
  "AUTH_UNAVAILABLE",
  "AUTH_REQUIRED",
  "MFA_REQUIRED",
  "RECOVERY_ACK_REQUIRED",
  "SETUP_DATA_REQUIRED",
  "SETUP_DATA_ALREADY_CHOSEN",
  "STEP_UP_REQUIRED",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Header carrying the server-generated request ID on every response. */
export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Error body of every API failure. `message` is a developer-facing fallback; `details` never
 * carries SQL, stacks, environment or record contents.
 */
export const apiErrorSchema = z
  .object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).nullable(),
    requestId: z.string().min(1),
  })
  .strict();

export type ApiError = z.infer<typeof apiErrorSchema>;
