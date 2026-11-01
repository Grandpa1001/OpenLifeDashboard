// Calls of the ConfigTable contract (Architektura §5.3, §6; D25.2) as typed results.
import {
  CONFIG_PATH,
  configEntryDeletedSchema,
  configEntryListSchema,
  configEntryPath,
  configEntrySchema,
  createConfigEntryRequestSchema,
  deleteConfigEntryRequestSchema,
  saveConfigEntryRequestSchema,
  type CreateConfigEntryRequest,
  type DeleteConfigEntryRequest,
  type SaveConfigEntryRequest,
} from "@openlife/contracts/http/config";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchConfigEntries = (signal?: AbortSignal) => apiRequest({ method: "GET", path: CONFIG_PATH, schema: configEntryListSchema, signal });

/** One entry as it is stored now: what a conflict is resolved against. */
export const fetchConfigEntry = (symbol: string, signal?: AbortSignal) => apiRequest({ method: "GET", path: configEntryPath(encodeURIComponent(symbol)), schema: configEntrySchema, signal });

export const createConfigEntry = (request: CreateConfigEntryRequest, signal?: AbortSignal) =>
  apiRequest({ method: "POST", path: CONFIG_PATH, body: createConfigEntryRequestSchema.parse(request), schema: configEntrySchema, signal });

/** The whole entry on the revision the form was built on: on another revision it is a conflict and writes nothing. */
export const saveConfigEntry = (symbol: string, request: SaveConfigEntryRequest, signal?: AbortSignal) =>
  apiRequest({ method: "PUT", path: configEntryPath(encodeURIComponent(symbol)), body: saveConfigEntryRequestSchema.parse(request), schema: configEntrySchema, signal });

/** A delete on the revision the owner saw; the answer says how many bindings point at nothing now. */
export const deleteConfigEntry = (symbol: string, request: DeleteConfigEntryRequest, signal?: AbortSignal) =>
  apiRequest({ method: "DELETE", path: configEntryPath(encodeURIComponent(symbol)), body: deleteConfigEntryRequestSchema.parse(request), schema: configEntryDeletedSchema, signal });
