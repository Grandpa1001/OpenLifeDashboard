// Public API of the identity module (Architektura §13.2, §18.7).
export { chooseEmptyData } from "./application/choose-data.js";
export type { ChooseDataDependencies, DataChosen } from "./application/choose-data.js";
export { resetOwnerMfa } from "./application/reset-mfa.js";
export type { MfaReset, ResetMfaCommand } from "./application/reset-mfa.js";
export { authorizeLiveStream } from "./application/live-stream-access.js";
export type { LiveStreamDependencies, LiveStreamHolder, LiveStreamPorts } from "./application/live-stream-access.js";
export { disableSecondFactor, restartSecondFactor } from "./application/manage-factor.js";
export type { FactorDisabled, FactorManagementDependencies, FactorRestarted } from "./application/manage-factor.js";
export { confirmOwnerPassword } from "./application/confirm-password.js";
export type { ConfirmPasswordDependencies, PasswordConfirmed } from "./application/confirm-password.js";
export { changeOwnerPassword } from "./application/change-password.js";
export type { ChangePasswordDependencies, ChangePasswordRequest, PasswordChanged, PasswordHasherPort } from "./application/change-password.js";
export { regenerateRecoveryCodes } from "./application/regenerate-recovery.js";
export type { RegenerateRecoveryDependencies, RegeneratedRecoveryCodes } from "./application/regenerate-recovery.js";
export { listTrustedDevices, revokeAllTrustedDevices, revokeTrustedDevice } from "./application/manage-devices.js";
export type { DeviceManagementDependencies } from "./application/manage-devices.js";
export { listOwnerSessions, revokeOtherSessions, revokeOwnerSession } from "./application/manage-sessions.js";
export type { OwnerSession, SessionManagementDependencies } from "./application/manage-sessions.js";
export { resolveSessionAccess } from "./application/session-access.js";
export type { SessionAccess } from "./application/session-access.js";
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
  ChangePasswordPorts,
  ChooseDataPorts,
  ConfirmPasswordPorts,
  FactorManagementPorts,
  CredentialReader,
  DeviceManagementPorts,
  MfaCrypto,
  EnrollmentPorts,
  IdentityAccessReader,
  MfaRecord,
  MfaStore,
  NewSession,
  OwnerCredential,
  RecoveryCodeStore,
  RegenerateRecoveryPorts,
  ResetMfaPorts,
  SessionFacts,
  SessionManagementPorts,
  SessionSummary,
  SetupStateStore,
  SessionStore,
  SignInPorts,
  TrustedDeviceStore,
  TrustedDeviceSummary,
  VerificationPorts,
} from "./ports.js";
