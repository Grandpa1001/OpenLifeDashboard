// Calls of the diagnostics (Architektura §15.3; D44) as typed results. The overview, the list of the log
// files and the lines of one request are reads; the files and the report are downloads the browser makes by a
// link (the cookie goes with it), so the SPA only builds their addresses from the contract.
import {
  DIAGNOSTICS_PATH,
  DIAGNOSTICS_LOGS_PATH,
  DIAGNOSTICS_REPORT_PATH,
  diagnosticsLogPath,
  diagnosticsRequestPath,
  diagnosticsSchema,
  logFileListSchema,
  requestLogSchema,
} from "@openlife/contracts/http/diagnostics";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchDiagnostics = (signal?: AbortSignal) => apiRequest({ method: "GET", path: DIAGNOSTICS_PATH, schema: diagnosticsSchema, signal });
export const fetchLogFiles = (signal?: AbortSignal) => apiRequest({ method: "GET", path: DIAGNOSTICS_LOGS_PATH, schema: logFileListSchema, signal });
export const searchRequestLog = (requestId: string, signal?: AbortSignal) => apiRequest({ method: "GET", path: diagnosticsRequestPath(requestId), schema: requestLogSchema, signal });

/** Where the browser downloads a file of the log, and the report. */
export const logFileDownloadPath = diagnosticsLogPath;
export const REPORT_DOWNLOAD_PATH = DIAGNOSTICS_REPORT_PATH;
