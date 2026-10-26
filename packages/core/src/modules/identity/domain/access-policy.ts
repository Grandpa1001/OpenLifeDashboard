// The one access policy (Architektura §9.7, §18.7; D10.2): a pure decision over a snapshot of
// the owner, the session, the second factor and the setup, a named operation and an injected
// clock. Policy, enrollment state, data choice and the assurance of the session are separate
// inputs and none stands in for another. The order of the checks is the order of the answers:
// identity (401) → recovery acknowledgment → second factor → data choice → freshness (403/409).

export type MfaPolicy = "required" | "disabled" | "reset_required";
export type EnrollmentState = "required" | "awaiting_recovery_ack" | "complete";
export type Assurance = "password" | "totp" | "trusted" | "recovery";

export type IdentityAccessSnapshot = Readonly<{
  ownerExists: boolean;
  ownerMatches: boolean;
  sessionState: "active" | "missing" | "expired" | "revoked";
  epochMatches: boolean;
  mfaPolicy: MfaPolicy;
  enrollmentState: EnrollmentState;
  assurance: Assurance;
  trustedState: "not_used" | "valid" | "expired" | "revoked";
  dataChoice: "unselected" | "empty" | "imported";
  totpVerifiedAtMs: number | null;
  passwordVerifiedAtMs: number | null;
}>;

/** `data`: any private data; `step_up`: a sensitive action; `setup_data_choice`: choosing empty or imported data. */
export type AccessOperation = "data" | "step_up" | "setup_data_choice";

export type AccessDenial = Readonly<{
  allow: false;
  httpStatus: 401 | 403 | 409;
  code: "AUTH_REQUIRED" | "RECOVERY_ACK_REQUIRED" | "MFA_REQUIRED" | "SETUP_DATA_REQUIRED" | "STEP_UP_REQUIRED" | "SETUP_DATA_ALREADY_CHOSEN";
}>;
export type AccessDecision = Readonly<{ allow: true; httpStatus: 200 }> | AccessDenial;

/** A step-up factor is fresh for five minutes, inclusive; a timestamp in the future is never fresh. */
export const STEP_UP_FRESH_MS = 300_000;

const deny = (code: AccessDenial["code"]): AccessDecision => ({ allow: false, httpStatus: code === "AUTH_REQUIRED" ? 401 : code === "SETUP_DATA_ALREADY_CHOSEN" ? 409 : 403, code });
const ALLOWED: AccessDecision = { allow: true, httpStatus: 200 };

const isFresh = (verifiedAtMs: number | null, nowMs: number): boolean =>
  verifiedAtMs !== null && nowMs - verifiedAtMs >= 0 && nowMs - verifiedAtMs <= STEP_UP_FRESH_MS;

/** Whether the session's own proof satisfies the owner's current policy. */
function factorSatisfied(snapshot: IdentityAccessSnapshot): boolean {
  switch (snapshot.mfaPolicy) {
    case "reset_required":
      return false;
    case "disabled":
      // MFA was turned off on purpose: the password is the factor; any stronger proof also counts.
      return true;
    case "required":
      if (snapshot.enrollmentState !== "complete") {
        return false;
      }
      switch (snapshot.assurance) {
        case "totp":
          return snapshot.totpVerifiedAtMs !== null;
        case "recovery":
          return true;
        case "trusted":
          return snapshot.trustedState === "valid";
        case "password":
          return false;
      }
  }
}

export function decideAccess(snapshot: IdentityAccessSnapshot, operation: AccessOperation, nowMs: number): AccessDecision {
  if (!snapshot.ownerExists || !snapshot.ownerMatches || snapshot.sessionState !== "active" || !snapshot.epochMatches) {
    return deny("AUTH_REQUIRED");
  }
  if (snapshot.enrollmentState === "awaiting_recovery_ack") {
    return deny("RECOVERY_ACK_REQUIRED");
  }
  if (!factorSatisfied(snapshot)) {
    return deny("MFA_REQUIRED");
  }
  if (operation === "setup_data_choice") {
    // Choosing empty again is idempotent; imported data is never replaced.
    return snapshot.dataChoice === "imported" ? deny("SETUP_DATA_ALREADY_CHOSEN") : ALLOWED;
  }
  if (snapshot.dataChoice === "unselected") {
    return deny("SETUP_DATA_REQUIRED");
  }
  if (operation === "step_up") {
    // Trust and recovery open data but never produce a fresh TOTP; with MFA off the proof is the password.
    const verifiedAt = snapshot.mfaPolicy === "disabled" ? snapshot.passwordVerifiedAtMs : snapshot.totpVerifiedAtMs;
    return isFresh(verifiedAt, nowMs) ? ALLOWED : deny("STEP_UP_REQUIRED");
  }
  return ALLOWED;
}

/** What the browser does next, from the same decision (no second set of rules). */
export type NextAction = "login" | "create_owner" | "mfa_enrollment" | "mfa_challenge" | "recovery_ack" | "setup_data" | "ready";

export function nextActionFor(snapshot: IdentityAccessSnapshot, nowMs: number): NextAction {
  const decision = decideAccess(snapshot, "data", nowMs);
  if (decision.allow) {
    return "ready";
  }
  switch (decision.code) {
    case "AUTH_REQUIRED":
      return snapshot.ownerExists ? "login" : "create_owner";
    case "RECOVERY_ACK_REQUIRED":
      return "recovery_ack";
    case "MFA_REQUIRED":
      // No secret yet (or a reset) means enrollment; an enrolled owner proves the factor again.
      return snapshot.mfaPolicy === "reset_required" || snapshot.enrollmentState === "required" ? "mfa_enrollment" : "mfa_challenge";
    case "SETUP_DATA_REQUIRED":
      return "setup_data";
    case "STEP_UP_REQUIRED":
    case "SETUP_DATA_ALREADY_CHOSEN":
      return "ready";
  }
}
