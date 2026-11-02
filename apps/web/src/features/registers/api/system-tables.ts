// Calls of the system preview (Architektura §6; D32.1): the tables it knows and one page of one of them.
import { SYSTEM_TABLES_PATH, systemTableListSchema, systemTablePageSchema, systemTablePath } from "@openlife/contracts/http/system-tables";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchSystemTables = (signal?: AbortSignal) => apiRequest({ method: "GET", path: SYSTEM_TABLES_PATH, schema: systemTableListSchema, signal });

export const fetchSystemTablePage = (name: string, page: number, signal?: AbortSignal) =>
  apiRequest({ method: "GET", path: `${systemTablePath(name)}?page=${page}`, schema: systemTablePageSchema, signal });
