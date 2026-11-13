// Calls of the first-setup contract (Architektura §9.7, §18.7) as typed results.
import { chooseEmptyResponseSchema, importResponseSchema, SETUP_CHOOSE_EMPTY_PATH, SETUP_IMPORT_PATH } from "@openlife/contracts/http/setup";
import { apiRequest } from "../../../lib/api-client/request.js";

export const chooseEmptyData = (signal?: AbortSignal) =>
  apiRequest({ method: "POST", path: SETUP_CHOOSE_EMPTY_PATH, body: {}, schema: chooseEmptyResponseSchema, signal });

/** The file the owner chose goes to the server as it is; the server judges all of it (D46). */
export const importOwnerFile = (file: Blob, signal?: AbortSignal) => apiRequest({ method: "POST", path: SETUP_IMPORT_PATH, rawBody: file, schema: importResponseSchema, signal });

export { savePreferences } from "../../../lib/session/owner-setup.js";
