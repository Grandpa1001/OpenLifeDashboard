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
  "MFA_INVALID_CODE",
  "ENROLLMENT_CHANGED",
  "RECOVERY_BATCH_CHANGED",
  "REGISTRY_SYMBOL_TAKEN",
  "REGISTRY_LIMIT_EXCEEDED",
  "IDEMPOTENCY_CONFLICT",
  "SCHEMA_CHANGED",
  "SCREEN_LIMIT_EXCEEDED",
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

/** `details` of a rejected request: every reason found, each as a path of the field and a stable code, never a value. */
export const apiIssueListSchema = z.object({ issues: z.array(z.object({ path: z.string(), code: z.string() }).strict()) }).strict();
export type ApiIssue = z.infer<typeof apiIssueListSchema>["issues"][number];
