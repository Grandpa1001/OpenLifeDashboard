// The records of a registry over HTTP (Architektura §5.4, §6, §18; D15.3, D23.1): `POST` adds a
// record, `GET` returns a page of them with the count; one record is read (`GET`), changed (`PATCH`)
// and deleted (`DELETE`) by its identifier. All of it is private data: the gate is the access
// policy's answer, read again inside the unit. An add sends values, the revision of the schema it
// built the form on and an `Idempotency-Key`; a change and a delete send the revision of the record
// instead of a key. The identifier, owner, times and revision of the record are the server's.
// Nothing is cached.
import {
  createRecordRequestSchema,
  deleteRecordRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  listRecordsQuerySchema,
  REGISTRY_RECORD_PATH,
  REGISTRY_RECORDS_PATH,
  updateRecordRequestSchema,
  type RecordDto,
  type RecordPageDto,
} from "@openlife/contracts/http/records";
import type { ReadUnit, UnitOfWork } from "@openlife/core/foundation";
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord, type RecordDependencies, type RecordPorts, type StoredRecord } from "@openlife/core/registries";
import type { Context, Hono } from "hono";
import type { SignedCookie } from "../../adapters/auth/session-cookie.js";
import type { Announce } from "../../adapters/events/live-hub.js";
import type { TechnicalLogger } from "../../adapters/logging/technical-logger.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";
import { JSON_BODY_MAX_BYTES } from "../security-limits.js";
import { createSessionOperationKit } from "../session-operation.js";

export type RecordRouteDependencies = Readonly<{
  unit: UnitOfWork<RecordPorts> & ReadUnit<RecordPorts>;
  cookies: SignedCookie;
  allowedOrigin: string;
  nowMs: () => number;
  newId: () => string;
  hash: (text: string) => string;
  limits: RecordDependencies["limits"];
  /** The largest record now; read at each write, so a changed option applies to the next one. */
  recordMaxBytes: () => number;
  logger: TechnicalLogger;
}>;

/** The registry the path names; a path without one cannot reach a handler, and an empty symbol is a registry that does not exist. */
const symbolOf = (c: Context<AppEnv>): string => c.req.param("symbol") ?? "";

const recordIdOf = (c: Context<AppEnv>): string => c.req.param("recordId") ?? "";

/** The public shape of a record: its values and revision, not its owner or its registry. */
const toDto = (record: StoredRecord): RecordDto => ({ id: record.id, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, values: record.values });

export function registerRecordRoutes(app: Hono<AppEnv>, deps: RecordRouteDependencies, announce: Announce): void {
  const { guard, operation, read, refused } = createSessionOperationKit({ allowedOrigin: deps.allowedOrigin, cookies: deps.cookies, logger: deps.logger, bodyMaxBytes: JSON_BODY_MAX_BYTES });
  const records = { unit: deps.unit, nowMs: deps.nowMs, newId: deps.newId, hash: deps.hash, limits: deps.limits, recordMaxBytes: deps.recordMaxBytes };

  app.post(
    REGISTRY_RECORDS_PATH,
    ...guard,
    operation(createRecordRequestSchema, async (c, token, body) => {
      const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
      if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
        return apiErrorResponse(c, 422, "VALIDATION_FAILED", { issues: [{ path: `header.${IDEMPOTENCY_KEY_HEADER}`, code: key === undefined ? "KEY_MISSING" : "KEY_INVALID" }] });
      }
      const result = createRecord(records, token, { symbol: symbolOf(c), idempotencyKey: key, schemaRevision: body.schemaRevision, values: body.values }, c.get("requestId"));
      if (!result.ok) {
        return refused(c, result.error);
      }
      // A replayed add wrote nothing, so there is nothing to tell.
      if (!result.value.replayed) announce({ type: "data.changed", registry: symbolOf(c) });
      return c.json(toDto(result.value.record), result.value.replayed ? 200 : 201);
    }),
  );

  app.get(
    REGISTRY_RECORD_PATH,
    read((c, token) => {
      const result = getRecord(records, token, { symbol: symbolOf(c), recordId: recordIdOf(c) }, c.get("requestId"));
      return result.ok ? c.json(toDto(result.value)) : refused(c, result.error);
    }),
  );

  app.patch(
    REGISTRY_RECORD_PATH,
    ...guard,
    operation(updateRecordRequestSchema, async (c, token, body) => {
      const result = updateRecord(records, token, { symbol: symbolOf(c), recordId: recordIdOf(c), schemaRevision: body.schemaRevision, expectedRevision: body.expectedRevision, values: body.values }, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      announce({ type: "data.changed", registry: symbolOf(c) });
      return c.json(toDto(result.value));
    }),
  );

  app.delete(
    REGISTRY_RECORD_PATH,
    ...guard,
    operation(deleteRecordRequestSchema, async (c, token, body) => {
      const result = deleteRecord(records, token, { symbol: symbolOf(c), recordId: recordIdOf(c), expectedRevision: body.expectedRevision }, c.get("requestId"));
      if (!result.ok) return refused(c, result.error);
      announce({ type: "data.changed", registry: symbolOf(c) });
      return c.body(null, 204);
    }),
  );

  app.get(
    REGISTRY_RECORDS_PATH,
    read((c, token) => {
      // A parameter given twice is ambiguous, not "the first one".
      const given = Object.entries(c.req.queries());
      const query = given.some(([, values]) => values.length > 1) ? null : listRecordsQuerySchema.safeParse(Object.fromEntries(given.map(([name, values]) => [name, values[0]])));
      if (query === null || !query.success) {
        return apiErrorResponse(c, 422, "VALIDATION_FAILED");
      }
      const { sort, direction, page, pageSize, search } = query.data;
      const result = listRecords(records, token, { symbol: symbolOf(c), ...(sort === undefined ? {} : { sort }), ...(direction === undefined ? {} : { direction }), ...(page === undefined ? {} : { page }), ...(pageSize === undefined ? {} : { pageSize }), ...(search === undefined ? {} : { search }) }, c.get("requestId"));
      if (!result.ok) {
        return refused(c, result.error);
      }
      const { registry, records: found, labels, total, page: shownPage, pageSize: shownSize } = result.value;
      const dto: RecordPageDto = { records: found.map(toDto), labels, total, page: shownPage, pageSize: shownSize, schemaRevision: registry.schemaRevision, dataRevision: registry.dataRevision };
      return c.json(dto);
    }),
  );
}
