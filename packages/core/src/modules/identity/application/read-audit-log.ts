// Reading the audit log for the Security page (it lives with the identity module, which decides who may read: the audit
// module takes no dependency on identity) (Scope §5.9; Architektura §9.8, §11): the events newest first,
// fifty to a page, optionally of one kind, with the address and the browser of an entry in full. It is private
// data of the owner, so the access policy decides, and it writes nothing. The log holds operation types and
// permitted context only (never a password, a token or a secret), so an entry can be shown as it was stored.
import type { ReadUnit, Result } from "../../../foundation/public.js";
import { AUDIT_KIND_FILTERS, auditKindOf, type AuditKind, type AuditLogReader, type AuditRecord } from "../../audit/public.js";
import { decideAccess } from "../domain/access-policy.js";
import type { IdentityAccessReader, SessionStore } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";

/** Entries on a page of the log. */
export const AUDIT_PAGE_SIZE = 50;

export type AuditLogPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  auditLog: AuditLogReader;
}>;

export type AuditLogDependencies = Readonly<{ unit: ReadUnit<AuditLogPorts>; nowMs: () => number }>;

export type AuditLogEntry = AuditRecord & Readonly<{ kind: AuditKind | null }>;
export type AuditLogView = Readonly<{ entries: readonly AuditLogEntry[]; page: number; pageSize: number; total: number }>;

/** `page` counts from 1; a page beyond the last is empty, not an error. */
export function readAuditLog(deps: AuditLogDependencies, token: string, request: Readonly<{ kind?: AuditKind; page: number }>, requestId: string): Result<AuditLogView> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<AuditLogView> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return { ok: false, error: { code: "AUTH_REQUIRED" } };
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      return { ok: false, error: { code: decision.code } };
    }
    const found = ports.auditLog.page({ filter: request.kind === undefined ? null : AUDIT_KIND_FILTERS[request.kind], offset: (request.page - 1) * AUDIT_PAGE_SIZE, limit: AUDIT_PAGE_SIZE });
    return { ok: true, value: { entries: found.entries.map((entry) => ({ ...entry, kind: auditKindOf(entry.action) })), page: request.page, pageSize: AUDIT_PAGE_SIZE, total: found.total } };
  });
}
