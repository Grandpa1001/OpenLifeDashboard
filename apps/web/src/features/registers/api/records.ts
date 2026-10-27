// Calls of the records contract (Architektura §5.4, §18.7) as typed results.
import { createRecordRequestSchema, IDEMPOTENCY_KEY_HEADER, recordPageSchema, recordSchema, registryRecordsPath, type CreateRecordRequest } from "@openlife/contracts/http/records";
import { apiRequest } from "../../../lib/api-client/request.js";

export const fetchRecordPage = (symbol: string, page: number, pageSize: number, signal?: AbortSignal) =>
  apiRequest({ method: "GET", path: `${registryRecordsPath(encodeURIComponent(symbol))}?page=${page}&pageSize=${pageSize}`, schema: recordPageSchema, signal });

/** The add carries the key of the attempt: the same key with the same body is one record, however often it is sent. */
export const addRecord = (symbol: string, key: string, request: CreateRecordRequest, signal?: AbortSignal) => {
  const body = createRecordRequestSchema.parse(request);
  return apiRequest({ method: "POST", path: registryRecordsPath(encodeURIComponent(symbol)), body, headers: { [IDEMPOTENCY_KEY_HEADER]: key }, schema: recordSchema, signal });
};
