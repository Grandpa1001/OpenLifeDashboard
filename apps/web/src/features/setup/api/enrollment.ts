// Calls of the enrollment contract (Architektura §9.7, §18.7) as typed results.
import {
  enrollmentChallengeSchema,
  enrollmentStatusSchema,
  issuedRecoveryCodesSchema,
  MFA_ENROLLMENT_BEGIN_PATH,
  MFA_ENROLLMENT_CONFIRM_PATH,
  MFA_RECOVERY_ACK_PATH,
  MFA_RECOVERY_REISSUE_PATH,
  type EnrollmentChallengeDto,
  type IssuedRecoveryCodesDto,
} from "@openlife/contracts/http/mfa";
import type { NextAction } from "@openlife/contracts/http/identity";
import { apiRequest, type ApiResult } from "../../../lib/api-client/request.js";

/** Starts the enrollment, or returns the one already running for this session. */
export const beginEnrollment = (signal?: AbortSignal): Promise<ApiResult<EnrollmentChallengeDto>> =>
  apiRequest({ method: "POST", path: MFA_ENROLLMENT_BEGIN_PATH, body: {}, schema: enrollmentChallengeSchema, signal });

export const confirmEnrollment = (challengeId: string, code: string, signal?: AbortSignal): Promise<ApiResult<IssuedRecoveryCodesDto>> =>
  apiRequest({ method: "POST", path: MFA_ENROLLMENT_CONFIRM_PATH, body: { challengeId, code }, schema: issuedRecoveryCodesSchema, signal });

/** A lost view of the codes: a fresh code from the app replaces the batch. */
export const reissueRecoveryCodes = (code: string, signal?: AbortSignal): Promise<ApiResult<IssuedRecoveryCodesDto>> =>
  apiRequest({ method: "POST", path: MFA_RECOVERY_REISSUE_PATH, body: { code }, schema: issuedRecoveryCodesSchema, signal });

export const acknowledgeRecovery = (batchId: string, signal?: AbortSignal): Promise<ApiResult<{ nextAction: NextAction }>> =>
  apiRequest({ method: "POST", path: MFA_RECOVERY_ACK_PATH, body: { batchId }, schema: enrollmentStatusSchema, signal });
