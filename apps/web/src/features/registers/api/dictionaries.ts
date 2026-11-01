// Calls of the dictionaries contract (Architektura §4.2, §5.2, §6; D24.2) as typed results.
import {
  createDictionaryRequestSchema,
  DICTIONARIES_PATH,
  dictionaryDeletedSchema,
  dictionaryListSchema,
  dictionaryPath,
  dictionarySchema,
  deleteDictionaryRequestSchema,
  saveDictionaryRequestSchema,
  type CreateDictionaryRequest,
  type DeleteDictionaryRequest,
  type SaveDictionaryRequest,
} from "@openlife/contracts/http/dictionaries";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchDictionaries = (signal?: AbortSignal) => apiRequest({ method: "GET", path: DICTIONARIES_PATH, schema: dictionaryListSchema, signal });

/** One dictionary as it is stored now: what a conflict is resolved against. */
export const fetchDictionary = (symbol: string, signal?: AbortSignal) => apiRequest({ method: "GET", path: dictionaryPath(encodeURIComponent(symbol)), schema: dictionarySchema, signal });

export const createDictionary =(request: CreateDictionaryRequest, signal?: AbortSignal) =>
  apiRequest({ method: "POST", path: DICTIONARIES_PATH, body: createDictionaryRequestSchema.parse(request), schema: dictionarySchema, signal });

/** The whole content on the revision the editor was built on: on another revision it is a conflict and writes nothing. */
export const saveDictionary = (symbol: string, request: SaveDictionaryRequest, signal?: AbortSignal) =>
  apiRequest({ method: "PUT", path: dictionaryPath(encodeURIComponent(symbol)), body: saveDictionaryRequestSchema.parse(request), schema: dictionarySchema, signal });

/** A delete on the revision the owner saw; the answer names the columns it unpinned. */
export const deleteDictionary = (symbol: string, request: DeleteDictionaryRequest, signal?: AbortSignal) =>
  apiRequest({ method: "DELETE", path: dictionaryPath(encodeURIComponent(symbol)), body: deleteDictionaryRequestSchema.parse(request), schema: dictionaryDeletedSchema, signal });
