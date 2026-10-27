// Calls of the sign-in and second-factor contracts (Architektura §9.8, §18.7) as typed results.
import { identityStatusSchema, SIGN_IN_PATH, type IdentityStatus, type LoginRequest } from "@openlife/contracts/http/identity";
import { mfaVerifiedSchema, MFA_VERIFY_PATH, type MfaVerifiedDto } from "@openlife/contracts/http/mfa";
import { apiRequest, type ApiResult } from "../../../lib/api-client/request.js";

/** The password is sent exactly as typed. */
export const signIn = (credentials: LoginRequest, signal?: AbortSignal): Promise<ApiResult<IdentityStatus>> =>
  apiRequest({ method: "POST", path: SIGN_IN_PATH, body: credentials, schema: identityStatusSchema, signal });

export type FactorProof = Readonly<{ code: string; rememberDevice: boolean }> | Readonly<{ recoveryCode: string }>;

export const verifyFactor = (proof: FactorProof, signal?: AbortSignal): Promise<ApiResult<MfaVerifiedDto>> =>
  apiRequest({ method: "POST", path: MFA_VERIFY_PATH, body: proof, schema: mfaVerifiedSchema, signal });
