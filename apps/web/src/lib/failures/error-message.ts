// What a failed call says to the owner: the key of a translated text, never the server's own
// message (Architektura §7.6). Only a stable code selects the text, so a body that was changed or
// forged cannot put its words on the screen.
import type { ApiFailure } from "../api-client/request.js";

export type ErrorKey =
  | "INVALID_CREDENTIALS"
  | "AUTH_LOCKED"
  | "RATE_LIMITED"
  | "MFA_INVALID_CODE"
  | "ENROLLMENT_CHANGED"
  | "RECOVERY_BATCH_CHANGED"
  | "SETUP_DATA_ALREADY_CHOSEN"
  | "AUTH_REQUIRED"
  | "VALIDATION_FAILED"
  | "REGISTRY_SYMBOL_TAKEN"
  | "REGISTRY_LIMIT_EXCEEDED"
  | "AUTH_UNAVAILABLE"
  | "ORIGIN_FORBIDDEN"
  | "INTERNAL_ERROR"
  | "NETWORK"
  | "INVALID_RESPONSE"
  | "UNKNOWN";

export type ErrorMessage = Readonly<{
  key: ErrorKey;
  /** Minutes to wait, for the keys that are plural in them. */
  minutes?: number;
  requestId: string | null;
  /** The call came back with a lock: no new attempt makes sense until this many seconds pass. */
  lockSeconds: number | null;
}>;

const KNOWN_API_CODES: ReadonlySet<string> = new Set<ErrorKey>([
  "INVALID_CREDENTIALS",
  "AUTH_LOCKED",
  "RATE_LIMITED",
  "MFA_INVALID_CODE",
  "ENROLLMENT_CHANGED",
  "RECOVERY_BATCH_CHANGED",
  "SETUP_DATA_ALREADY_CHOSEN",
  "AUTH_REQUIRED",
  "VALIDATION_FAILED",
  "REGISTRY_SYMBOL_TAKEN",
  "REGISTRY_LIMIT_EXCEEDED",
  "AUTH_UNAVAILABLE",
  "ORIGIN_FORBIDDEN",
  "INTERNAL_ERROR",
]);

export function describeFailure(failure: Exclude<ApiFailure, { kind: "aborted" }>): ErrorMessage {
  if (failure.kind === "network") {
    return { key: "NETWORK", requestId: null, lockSeconds: null };
  }
  if (failure.kind === "invalid-response") {
    return { key: "INVALID_RESPONSE", requestId: null, lockSeconds: null };
  }
  const key: ErrorKey = KNOWN_API_CODES.has(failure.code) ? (failure.code as ErrorKey) : "UNKNOWN";
  const locked = key === "AUTH_LOCKED" || key === "RATE_LIMITED";
  const seconds = locked ? (failure.retryAfterSeconds ?? 60) : null;
  return { key, requestId: failure.requestId, lockSeconds: seconds, ...(seconds === null ? {} : { minutes: Math.max(1, Math.ceil(seconds / 60)) }) };
}
