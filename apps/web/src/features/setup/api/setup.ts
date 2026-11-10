// Calls of the first-setup contract (Architektura §9.7, §18.7) as typed results.
import { chooseEmptyResponseSchema, SETUP_CHOOSE_EMPTY_PATH } from "@openlife/contracts/http/setup";
import { apiRequest } from "../../../lib/api-client/request.js";

export const chooseEmptyData = (signal?: AbortSignal) =>
  apiRequest({ method: "POST", path: SETUP_CHOOSE_EMPTY_PATH, body: {}, schema: chooseEmptyResponseSchema, signal });

export { savePreferences } from "../../../lib/session/owner-setup.js";
