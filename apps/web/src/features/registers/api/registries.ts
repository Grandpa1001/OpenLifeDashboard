// Calls of the registries contract (Architektura §5.1, §18.7) as typed results.
import { REGISTRIES_PATH, registryListSchema } from "@openlife/contracts/http/registries";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchRegistries = (signal?: AbortSignal) => apiRequest({ method: "GET", path: REGISTRIES_PATH, schema: registryListSchema, signal });
