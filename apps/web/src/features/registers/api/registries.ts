// Calls of the registries contract (Architektura §5.1, §18.7) as typed results.
import { REGISTRIES_PATH, REGISTRY_SUMMARIES_PATH, registryListSchema, registrySummaryListSchema } from "@openlife/contracts/http/registries";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchRegistries = (signal?: AbortSignal) => apiRequest({ method: "GET", path: REGISTRIES_PATH, schema: registryListSchema, signal });

/** The records and the widgets of each registry, for its card (D32.2). */
export const fetchRegistrySummaries = (signal?: AbortSignal) => apiRequest({ method: "GET", path: REGISTRY_SUMMARIES_PATH, schema: registrySummaryListSchema, signal });
