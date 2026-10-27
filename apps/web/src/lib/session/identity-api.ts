// The calls every signed-in screen shares: the status the server reports and the sign-out
// (Architektura §9.8, §18.7), as typed results.
import { identityStatusSchema, IDENTITY_STATUS_PATH, SIGN_OUT_PATH, type IdentityStatus } from "@openlife/contracts/http/identity";
import { apiRequest, type ApiResult } from "../api-client/request.js";

export const fetchIdentityStatus = (signal?: AbortSignal): Promise<ApiResult<IdentityStatus>> =>
  apiRequest({ method: "GET", path: IDENTITY_STATUS_PATH, schema: identityStatusSchema, signal });

export const signOut = (signal?: AbortSignal): Promise<ApiResult<null>> => apiRequest({ method: "POST", path: SIGN_OUT_PATH, body: {}, schema: null, signal });
