// The state of the check of the releases (Architektura §11.1; D53.4) as the SPA reads it: one query for the page of the
// updates and for the version mark of the bar, so both show the same answer and one request serves them. The calls take
// nothing: the source of the releases is the installation's, never something the page could give.
import { updatesCheckBodySchema, updatesCheckResultSchema, updatesStatusSchema, UPDATES_CHECK_PATH, UPDATES_PATH } from "@openlife/contracts/http/updates";
import { apiRequest } from "../api-client/request.js";
import { queryKeys } from "../query-keys/index.js";

export const fetchUpdates = (signal?: AbortSignal) => apiRequest({ method: "GET", path: UPDATES_PATH, schema: updatesStatusSchema, signal });

/** "Check now": the request is empty by contract; there is no address, repository or version to send. */
export const checkUpdatesNow = (signal?: AbortSignal) => apiRequest({ method: "POST", path: UPDATES_CHECK_PATH, body: updatesCheckBodySchema.parse({}), schema: updatesCheckResultSchema, signal });

/** The query of the state; a failed read is an error the callers show or leave out, never a state of the check. */
export const updatesStatusQuery = {
  queryKey: queryKeys.updates.status,
  queryFn: async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
    const result = await fetchUpdates(signal);
    if (!result.ok) throw result.failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new Error("updates unavailable");
    return result.value;
  },
  retry: false,
} as const;
