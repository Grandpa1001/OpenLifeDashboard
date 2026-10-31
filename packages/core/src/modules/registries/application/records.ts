// Adding, listing, reading, changing and deleting the records of a registry (Architektura §4.6,
// §5.4, §18; D15.3, D23.1). A write runs in one unit of work: the access policy is read again inside
// it and the registry is the catalog's as it stands in that unit. An add binds an idempotency key:
// a repeated key answers with the first answer without writing, and the record, its data revision
// and its entry commit together. A change and a delete name the revision the form was built on and
// succeed only on that revision (compare and set), so a repeat after a lost answer is a conflict or
// a missing record, never a second effect. The identifier, the times and the owner are the server's;
// the client sends values. Records are not audited one by one (§18.2).
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import type { RegistryLimits } from "../domain/limits.js";
import { canonicalRecordRequest, PAGE_SIZE_MAX, PAGE_SIZE_MIN, resolveSortColumn, validateRecordChanges, validateRecordValues, type RecordIssue, type SortDirection } from "../domain/record-rules.js";
import type { IdempotencyStore, RecordStore, RegistryStore, StoredRecord, StoredRegistry } from "../ports.js";

export type RecordPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  registries: RegistryStore;
  records: RecordStore;
  idempotency: IdempotencyStore;
}>;

export type RecordDependencies = Readonly<{
  unit: UnitOfWork<RecordPorts> & ReadUnit<RecordPorts>;
  nowMs: () => number;
  /** A new identifier (UUIDv7) for a record. */
  newId: () => string;
  /** Hex SHA-256 of a text; the platform's, because core uses no platform API. */
  hash: (text: string) => string;
  limits: RegistryLimits;
  /** The largest record, in bytes of its values as JSON (`limits.recordMaxKiB`). */
  recordMaxBytes: number;
}>;

/** How long a key answers with the first answer (Architektura §4.6). */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RECORD_MAX_BYTES = 192 * 1024;

export const LIST_DEFAULTS = { sort: "created_at", direction: "desc", page: 1, pageSize: 25 } as const;

const operationOf = (registry: StoredRegistry): string => `registries.record.create:${registry.id}`;

export type NewRecordInput = Readonly<{ symbol: string; idempotencyKey: string; schemaRevision: number; values: unknown }>;
export type CreatedRecord = Readonly<{ record: StoredRecord; /** True when the key had been used and nothing was written. */ replayed: boolean }>;

function openRegistry(ports: RecordPorts, ownerId: string, symbol: string): StoredRegistry {
  const registry = ports.registries.find(ownerId, symbol);
  if (registry === null || registry.deletedAt !== null) {
    throw new DomainFault({ code: "NOT_FOUND" });
  }
  return registry;
}

/** The owner of a write: the session is read again inside the unit and must pass the data access. */
function writerOf(ports: RecordPorts, token: string, nowMs: number, requestId: string): string {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) {
    throw new DomainFault({ code: "AUTH_REQUIRED" });
  }
  const decision = decideAccess(access.snapshot, "data", nowMs);
  if (!decision.allow) {
    throw new DomainFault({ code: decision.code });
  }
  return access.session.ownerId;
}

const invalid = (issues: readonly RecordIssue[]): DomainFault => new DomainFault({ code: "VALIDATION_FAILED", fields: [...new Set(issues.map((issue) => issue.path))], issues });

const policyOf = (deps: Pick<RecordDependencies, "limits" | "recordMaxBytes">) => ({ maxTextCodePoints: deps.limits.textMaxChars, maxRecordBytes: deps.recordMaxBytes });

export function createRecord(deps: RecordDependencies, token: string, input: NewRecordInput, requestId: string): Result<CreatedRecord> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<CreatedRecord> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const registry = openRegistry(ports, ownerId, input.symbol);
    const nowIso = new Date(nowMs).toISOString();

    // A key that was used answers first, also when the form has changed since: the first request was valid.
    const requestHash = deps.hash(canonicalRecordRequest(input.schemaRevision, input.values));
    const operation = operationOf(registry);
    const earlier = ports.idempotency.find(ownerId, operation, input.idempotencyKey, nowIso);
    if (earlier !== null) {
      if (earlier.requestHash !== requestHash) {
        throw new DomainFault({ code: "IDEMPOTENCY_CONFLICT" });
      }
      return { value: { record: earlier.response, replayed: true }, invalidations: [] };
    }

    if (input.schemaRevision !== registry.schemaRevision) {
      throw new DomainFault({ code: "SCHEMA_CHANGED" });
    }
    const checked = validateRecordValues({ schemaRevision: registry.schemaRevision, columns: registry.columns }, input.values, policyOf(deps));
    if (!checked.ok) {
      throw invalid(checked.issues);
    }

    const record: StoredRecord = { id: deps.newId(), registryId: registry.id, ownerId, revision: 1, createdAt: nowIso, updatedAt: nowIso, values: checked.values };
    ports.records.insert(registry, record);
    ports.idempotency.put({ ownerId, operation, key: input.idempotencyKey, requestHash, response: record, createdAt: nowIso, expiresAt: new Date(nowMs + IDEMPOTENCY_RETENTION_MS).toISOString() });
    return { value: { record, replayed: false }, invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

export type RecordChangeInput = Readonly<{ symbol: string; recordId: string; schemaRevision: number; expectedRevision: number; /** Only the columns that change. */ values: unknown }>;

/**
 * Changes a stored record. The checks run in the order a form can act on: a record that is not the
 * owner's is missing; a form built on another schema reloads the definition; a form built on
 * another revision of the record is a conflict and writes nothing; only then are the values joined
 * with the stored ones and checked whole. The record is replaced with the next revision.
 */
export function updateRecord(deps: Omit<RecordDependencies, "newId" | "hash">, token: string, input: RecordChangeInput, requestId: string): Result<StoredRecord> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<StoredRecord> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const registry = openRegistry(ports, ownerId, input.symbol);
    const stored = ports.records.find(registry, input.recordId);
    if (stored === null) {
      throw new DomainFault({ code: "NOT_FOUND" });
    }
    if (input.schemaRevision !== registry.schemaRevision) {
      throw new DomainFault({ code: "SCHEMA_CHANGED" });
    }
    if (input.expectedRevision !== stored.revision) {
      throw new DomainFault({ code: "RECORD_CONFLICT" });
    }
    const checked = validateRecordChanges({ schemaRevision: registry.schemaRevision, columns: registry.columns }, stored.values, input.values, policyOf(deps));
    if (!checked.ok) {
      throw invalid(checked.issues);
    }
    const next: StoredRecord = { ...stored, revision: stored.revision + 1, updatedAt: new Date(nowMs).toISOString(), values: checked.values };
    if (!ports.records.replaceIfRevision(registry, next, input.expectedRevision)) {
      throw new DomainFault({ code: "RECORD_CONFLICT" });
    }
    return { value: next, invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

export type RecordDeleteInput = Readonly<{ symbol: string; recordId: string; expectedRevision: number }>;

/** Deletes a stored record on the revision the owner saw; a record changed since is a conflict and stays. */
export function deleteRecord(deps: Pick<RecordDependencies, "unit" | "nowMs">, token: string, input: RecordDeleteInput, requestId: string): Result<null> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<null> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const registry = openRegistry(ports, ownerId, input.symbol);
    const stored = ports.records.find(registry, input.recordId);
    if (stored === null) {
      throw new DomainFault({ code: "NOT_FOUND" });
    }
    if (input.expectedRevision !== stored.revision || !ports.records.deleteIfRevision(registry, input.recordId, input.expectedRevision)) {
      throw new DomainFault({ code: "RECORD_CONFLICT" });
    }
    return { value: null, invalidations: [] };
  });
  return result.ok ? { ok: true, value: null } : result;
}

/** One record of a registry as it is stored now, after the same gate as every private read. */
export function getRecord(deps: Pick<RecordDependencies, "unit" | "nowMs">, token: string, input: Readonly<{ symbol: string; recordId: string }>, requestId: string): Result<StoredRecord> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<StoredRecord> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return { ok: false, error: { code: "AUTH_REQUIRED" } };
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      return { ok: false, error: { code: decision.code } };
    }
    const registry = ports.registries.find(access.session.ownerId, input.symbol);
    const record = registry === null || registry.deletedAt !== null ? null : ports.records.find(registry, input.recordId);
    return record === null ? { ok: false, error: { code: "NOT_FOUND" } } : { ok: true, value: record };
  });
}

export type RecordListQuery = Readonly<{ symbol: string; sort?: string; direction?: SortDirection; page?: number; pageSize?: number }>;
export type RecordListing = Readonly<{
  registry: Readonly<{ schemaRevision: number; dataRevision: number }>;
  records: readonly StoredRecord[];
  total: number;
  page: number;
  pageSize: number;
}>;

/** One page of the records of a registry and their count, read in one snapshot after the same gate as every private read. */
export function listRecords(deps: Pick<RecordDependencies, "unit" | "nowMs">, token: string, query: RecordListQuery, requestId: string): Result<RecordListing> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<RecordListing> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return { ok: false, error: { code: "AUTH_REQUIRED" } };
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      return { ok: false, error: { code: decision.code } };
    }
    const registry = ports.registries.find(access.session.ownerId, query.symbol);
    if (registry === null || registry.deletedAt !== null) {
      return { ok: false, error: { code: "NOT_FOUND" } };
    }
    const page = query.page ?? LIST_DEFAULTS.page;
    const pageSize = query.pageSize ?? LIST_DEFAULTS.pageSize;
    const sort = resolveSortColumn(registry.columns, query.sort ?? LIST_DEFAULTS.sort);
    const issues = [
      ...(sort === null ? [{ path: "sort", code: "SORT_UNKNOWN" }] : []),
      ...(!Number.isInteger(page) || page < 1 ? [{ path: "page", code: "PAGE_OUT_OF_RANGE" }] : []),
      ...(!Number.isInteger(pageSize) || pageSize < PAGE_SIZE_MIN || pageSize > PAGE_SIZE_MAX ? [{ path: "pageSize", code: "PAGE_SIZE_OUT_OF_RANGE" }] : []),
    ];
    if (sort === null || issues.length > 0) {
      return { ok: false, error: { code: "VALIDATION_FAILED", fields: issues.map((issue) => issue.path), issues } };
    }
    const found = ports.records.page(registry, { sort, direction: query.direction ?? LIST_DEFAULTS.direction, page, pageSize });
    return { ok: true, value: { registry: { schemaRevision: registry.schemaRevision, dataRevision: registry.dataRevision }, records: found.records, total: found.total, page, pageSize } };
  });
}
