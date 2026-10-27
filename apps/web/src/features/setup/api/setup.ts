// Calls of the first-setup contract (Architektura §9.7, §18.7) as typed results.
import {
  chooseEmptyResponseSchema,
  preferencesResponseSchema,
  SETUP_CHOOSE_EMPTY_PATH,
  SETUP_PREFERENCES_PATH,
  type OwnerPreferencesDto,
} from "@openlife/contracts/http/setup";
import { apiRequest } from "../../../lib/api-client/request.js";

export const chooseEmptyData = (signal?: AbortSignal) =>
  apiRequest({ method: "POST", path: SETUP_CHOOSE_EMPTY_PATH, body: {}, schema: chooseEmptyResponseSchema, signal });

/** Sent as typed: the server decides what is a valid zone, and a refusal is a result like any other. */
export const savePreferences = (preferences: OwnerPreferencesDto, signal?: AbortSignal) =>
  apiRequest({ method: "PUT", path: SETUP_PREFERENCES_PATH, body: preferences, schema: preferencesResponseSchema, signal });
