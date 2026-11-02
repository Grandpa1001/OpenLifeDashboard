// The system preview (Scope §3.1, §5.5; Architektura §6; D32.1): the tables of `SYSTEM_TABLES`, read
// only, after the same gate as every private read and in one unit of reading, so the count and the
// page agree. A name outside the list is a table that does not exist, whatever it names in the database.
import type { ReadUnit, Result } from "../../../foundation/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import { isSystemTableName, SYSTEM_TABLE_NAMES, SYSTEM_TABLES, type SystemRow, type SystemTableName } from "../domain/system-tables.js";
import type { SystemTableReader } from "../ports.js";

export type SystemTablePorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  systemTables: SystemTableReader;
}>;

export type SystemTableDependencies = Readonly<{ unit: ReadUnit<SystemTablePorts>; nowMs: () => number }>;

export type SystemTableOverview = Readonly<{ name: SystemTableName; columns: readonly string[]; rows: number }>;
export type SystemTablePage = Readonly<{ name: SystemTableName; columns: readonly string[]; rows: readonly SystemRow[]; total: number; page: number; pageSize: number }>;
/** A page from 1 and its size, as the HTTP contract has checked them. */
export type SystemTableQuery = Readonly<{ name: string; page: number; pageSize: number }>;

function ownerOf(ports: SystemTablePorts, token: string, nowMs: number, requestId: string): Result<string> {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
  const decision = decideAccess(access.snapshot, "data", nowMs);
  return decision.allow ? { ok: true, value: access.session.ownerId } : { ok: false, error: { code: decision.code } };
}

/** Every table of the preview with its columns and how many rows the owner has in it. */
export function listSystemTables(deps: SystemTableDependencies, token: string, requestId: string): Result<readonly SystemTableOverview[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly SystemTableOverview[]> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    return { ok: true, value: SYSTEM_TABLE_NAMES.map((name) => ({ name, columns: SYSTEM_TABLES[name], rows: ports.systemTables.count(owner.value, name) })) };
  });
}

/** One page of one table of the preview; an unknown name is NOT_FOUND, told after the gate so it says nothing to a stranger. */
export function readSystemTable(deps: SystemTableDependencies, token: string, query: SystemTableQuery, requestId: string): Result<SystemTablePage> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<SystemTablePage> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    if (!isSystemTableName(query.name)) return { ok: false, error: { code: "NOT_FOUND" } };
    const name = query.name;
    const total = ports.systemTables.count(owner.value, name);
    const rows = ports.systemTables.page(owner.value, name, (query.page - 1) * query.pageSize, query.pageSize);
    return { ok: true, value: { name, columns: SYSTEM_TABLES[name], rows, total, page: query.page, pageSize: query.pageSize } };
  });
}
