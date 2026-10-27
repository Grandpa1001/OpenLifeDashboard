import { REGISTRIES_PATH, registrySchema, type CreateRegistryRequest } from "@openlife/contracts/http/registries";
import { apiRequest } from "../../../lib/api-client/request.js";

/** The definition goes as typed; the server decides whether it is valid and gives the identifiers. */
export const createRegistry = (request: CreateRegistryRequest, signal?: AbortSignal) => apiRequest({ method: "POST", path: REGISTRIES_PATH, body: request, schema: registrySchema, signal });
