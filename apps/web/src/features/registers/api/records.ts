// Calls of the records contract (Architektura §5.4, §18.7) as typed results.
import {
  createRecordRequestSchema,
  deleteRecordRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  recordPageSchema,
  recordSchema,
  registryRecordPath,
  registryRecordsPath,
  updateRecordRequestSchema,
  type CreateRecordRequest,
  type DeleteRecordRequest,
  type UpdateRecordRequest,
} from "@openlife/contracts/http/records";
import { apiRequest } from "../../../lib/api-client/request.js";

export type RecordPageQuery = Readonly<{ page: number; pageSize: number; sort?: string; direction?: "asc" | "desc"; search?: string }>;

/** A page of records; the search, sort and page are query parameters, never part of a path. */
export const fetchRecordPage = (symbol: string, query: RecordPageQuery, signal?: AbortSignal) => {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.sort !== undefined) params.set("sort", query.sort);
  if (query.direction !== undefined) params.set("direction", query.direction);
  if (query.search !== undefined && query.search.trim() !== "") params.set("search", query.search);
  return apiRequest({ method: "GET", path: `${registryRecordsPath(encodeURIComponent(symbol))}?${params.toString()}`, schema: recordPageSchema, signal });
};

/** The add carries the key of the attempt: the same key with the same body is one record, however often it is sent. */
export const addRecord = (symbol: string, key: string, request: CreateRecordRequest, signal?: AbortSignal) => {
  const body = createRecordRequestSchema.parse(request);
  return apiRequest({ method: "POST", path: registryRecordsPath(encodeURIComponent(symbol)), body, headers: { [IDEMPOTENCY_KEY_HEADER]: key }, schema: recordSchema, signal });
};

/** One record as it is stored now: what a conflict is compared with. */
export const fetchRecord = (symbol: string, recordId: string, signal?: AbortSignal) =>
  apiRequest({ method: "GET", path: registryRecordPath(encodeURIComponent(symbol), encodeURIComponent(recordId)), schema: recordSchema, signal });

/** A change carries the revision of the record it was built on instead of a key: on another revision it is a conflict and writes nothing. */
export const updateRecord = (symbol: string, recordId: string, request: UpdateRecordRequest, signal?: AbortSignal) => {
  const body = updateRecordRequestSchema.parse(request);
  return apiRequest({ method: "PATCH", path: registryRecordPath(encodeURIComponent(symbol), encodeURIComponent(recordId)), body, schema: recordSchema, signal });
};

/** A delete on the revision the owner saw; the answer has no body. */
export const deleteRecord = (symbol: string, recordId: string, request: DeleteRecordRequest, signal?: AbortSignal) => {
  const body = deleteRecordRequestSchema.parse(request);
  return apiRequest({ method: "DELETE", path: registryRecordPath(encodeURIComponent(symbol), encodeURIComponent(recordId)), body, schema: null, signal });
};
