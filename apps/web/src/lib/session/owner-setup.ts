// The owner's setup as the guards need it once the gate is passed: the stage (is the starting
// data chosen, are the preferences saved) and the preferences themselves (Architektura §9.7, §18.7).
import { preferencesResponseSchema, SETUP_PREFERENCES_PATH, type OwnerPreferencesDto } from "@openlife/contracts/http/setup";
import type { QueryClient } from "@tanstack/react-query";
import { apiRequest, type ApiResult } from "../api-client/request.js";
import { queryKeys } from "../query-keys/index.js";
import { StatusUnavailableError } from "./identity-status.js";

export type OwnerSetup = Readonly<{ preferences: OwnerPreferencesDto | null; stage: "data" | "preferences" | "complete" }>;

export const fetchOwnerSetup = (signal?: AbortSignal): Promise<ApiResult<OwnerSetup>> =>
  apiRequest({ method: "GET", path: SETUP_PREFERENCES_PATH, schema: preferencesResponseSchema, signal });

/** Asked on every entry to a private screen of a signed-in owner; the cache never answers for the server. */
export function currentOwnerSetup(queryClient: QueryClient): Promise<OwnerSetup> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.setup.owner,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const result = await fetchOwnerSetup(signal);
      if (!result.ok) throw new StatusUnavailableError(result.failure);
      return result.value;
    },
  });
}
