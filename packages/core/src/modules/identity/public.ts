// Public API of the identity module (Architektura §13.2, §18.7).
export { resetOwnerPassword } from "./application/reset-password.js";
export type { PasswordReset, ResetPasswordCommand } from "./application/reset-password.js";
export { createOwner } from "./application/create-owner.js";
export type { CreateOwnerCommand, OwnerCreated } from "./application/create-owner.js";
export type { CreateOwnerPorts, CredentialWriter, NewOwnerAccount, OwnerSingletonWriter, ResetPasswordPorts } from "./ports.js";
export {
  acknowledgeRecovery,
  beginEnrollment,
  confirmEnrollment,
  ENROLLMENT_CHALLENGE_LIFETIME_MS,
  reissueRecoveryCodes,
} from "./application/enroll-totp.js";
export type { EnrollmentChallenge, EnrollmentDependencies, EnrollmentStatus, IssuedRecoveryCodes } from "./application/enroll-totp.js";
export type { FactorOperation, RequestContext } from "./application/factor-attempts.js";
export { stepUp, verifyRecoveryCode, verifyTotp } from "./application/verify-mfa.js";
export type { MfaProof, VerificationDependencies } from "./application/verify-mfa.js";
export { readIdentityStatus, signInWithPassword, signOut } from "./application/sign-in.js";
export type {
  AuthAttemptOutcome,
  IdentityStatus,
  PasswordVerifier,
  SignInDependencies,
  SignInRequest,
} from "./application/sign-in.js";
export { decideAccess, nextActionFor, STEP_UP_FRESH_MS } from "./domain/access-policy.js";
export type {
  Assurance,
  EnrollmentState,
  MfaPolicy,
  NextAction,
  AccessDecision,
  AccessDenial,
  AccessOperation,
  IdentityAccessSnapshot,
} from "./domain/access-policy.js";
export { LOCKOUT_DURATION_MS, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MS } from "./domain/lockout.js";
export type { LockoutBucket } from "./domain/lockout.js";
export { SESSION_LIFETIME_MS, TRUSTED_DEVICE_LIFETIME_MS } from "./domain/session-policy.js";
export type {
  AuthAttemptStore,
  CredentialReader,
  MfaCrypto,
  EnrollmentPorts,
  IdentityAccessReader,
  MfaRecord,
  MfaStore,
  NewSession,
  OwnerCredential,
  RecoveryCodeStore,
  SessionFacts,
  SessionStore,
  SignInPorts,
  TrustedDeviceStore,
  VerificationPorts,
} from "./ports.js";
