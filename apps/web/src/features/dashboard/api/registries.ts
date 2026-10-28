// The registries the Designer binds a widget to (Architektura §5.1, §18.7). The registers feature has its own call of the same contract: features do not import each other.
import { REGISTRIES_PATH, registryListSchema } from "@openlife/contracts/http/registries";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchRegistries = (signal?: AbortSignal) => apiRequest({ method: "GET", path: REGISTRIES_PATH, schema: registryListSchema, signal });
