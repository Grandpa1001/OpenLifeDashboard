// Calls of the application options (Architektura §14.1; D41.3, D42.2) as typed results.
import { patchSettingsRequestSchema, settingListSchema, settingPath, settingSchema, SETTINGS_PATH } from "@openlife/contracts/http/settings";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchAppSettings = (signal?: AbortSignal) => apiRequest({ method: "GET", path: SETTINGS_PATH, schema: settingListSchema, signal });

/** All the options given are changed or none. */
export const patchAppSettings = (values: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
  apiRequest({ method: "PATCH", path: SETTINGS_PATH, body: patchSettingsRequestSchema.parse({ values }), schema: settingListSchema, signal });

export const resetAppSetting = (key: string, signal?: AbortSignal) => apiRequest({ method: "DELETE", path: settingPath(key), body: {}, schema: settingSchema, signal });
