import type { QueryClient } from "@tanstack/react-query";
import type { ApiResult } from "../api-client/request.js";
import { signOut } from "./identity-api.js";
import { announceSignOut } from "./session-channel.js";

/**
 * Signs out and, once the server ended the session, drops everything private this tab cached and
 * tells the other tabs to do the same. A failure leaves the session and the cache as they were.
 */
export async function endSession(queryClient: QueryClient, signal?: AbortSignal): Promise<ApiResult<null>> {
  const result = await signOut(signal);
  if (result.ok) {
    queryClient.clear();
    announceSignOut();
  }
  return result;
}
