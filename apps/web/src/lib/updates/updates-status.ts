// The state of the check of the releases (Architektura §11.1; D53.4) as the SPA reads it: one query for the page of the
// updates and for the version mark of the bar, so both show the same answer and one request serves them. The calls take
// nothing: the source of the releases is the installation's, never something the page could give.
import { updatesCheckBodySchema, updatesCheckResultSchema, updatesInstallBodySchema, updatesInstallResultSchema, updatesStatusSchema, UPDATES_CHECK_PATH, UPDATES_INSTALL_PATH, UPDATES_PATH } from "@openlife/contracts/http/updates";
import { apiRequest } from "../api-client/request.js";
import { shouldPoll, UPDATE_POLL_MS } from "./operation-view.js";
import { queryKeys } from "../query-keys/index.js";

export const fetchUpdates = (signal?: AbortSignal) => apiRequest({ method: "GET", path: UPDATES_PATH, schema: updatesStatusSchema, signal });

/** "Check now": the request is empty by contract; there is no address, repository or version to send. */
export const checkUpdatesNow = (signal?: AbortSignal) => apiRequest({ method: "POST", path: UPDATES_CHECK_PATH, body: updatesCheckBodySchema.parse({}), schema: updatesCheckResultSchema, signal });

/**
 * Starts the update to a release (D57.1). The request carries the version and nothing else: never an image, an address or a path. An answer
 * of acceptance means the operation began, not that it succeeded; what became of it is read from the state, whatever happens to this call.
 */
export const installUpdate = (release: string, signal?: AbortSignal) => apiRequest({ method: "POST", path: UPDATES_INSTALL_PATH, body: updatesInstallBodySchema.parse({ release }), schema: updatesInstallResultSchema, signal });

/** The query of the state; a failed read is an error the callers show or leave out, never a state of the check. */
export const updatesStatusQuery = {
  queryKey: queryKeys.updates.status,
  queryFn: async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
    const result = await fetchUpdates(signal);
    if (!result.ok) throw result.failure.kind === "aborted" ? new DOMException("aborted", "AbortError") : new Error("updates unavailable");
    return result.value;
  },
  retry: false,
  // While an update goes on the state is asked for again; a read that fails (the application is being replaced) keeps the last state and the polling.
  refetchInterval: (query: Readonly<{ state: Readonly<{ data: Parameters<typeof shouldPoll>[0] }> }>) => (shouldPoll(query.state.data) ? UPDATE_POLL_MS : false),
} as const;
