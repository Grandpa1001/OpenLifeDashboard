// The identity status as cached server state, and the one way a guard asks for it
// (Architektura §9.6: no cache may delay a logout or a revocation). A guard always asks the
// server; the cache only carries the answer to the screen that renders next.
import type { IdentityStatus } from "@openlife/contracts/http/identity";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../query-keys/index.js";
import type { ApiFailure } from "../api-client/request.js";
import { fetchIdentityStatus } from "./identity-api.js";

/** The server could not tell who the caller is: the guard cannot decide, and says so instead of guessing. */
export class StatusUnavailableError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super("identity status unavailable");
    this.name = "StatusUnavailableError";
    this.failure = failure;
  }
}

export function currentIdentityStatus(queryClient: QueryClient): Promise<IdentityStatus> {
  return queryClient.fetchQuery({
    queryKey: queryKeys.identity.status,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const result = await fetchIdentityStatus(signal);
      if (!result.ok) {
        throw new StatusUnavailableError(result.failure);
      }
      return result.value;
    },
  });
}
