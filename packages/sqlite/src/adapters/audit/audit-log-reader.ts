// AuditLogReader on the handle of a unit of work (Architektura §4.2, §9.8; D43.6): a page of the trail,
// newest first, optionally of one kind. The adapter owns `audit_log`; the filter arrives as names of
// entities and actions and becomes bound parameters, never text of a statement. It writes nothing.
import type { AuditDetails, AuditLogReader, AuditQuery, AuditRecord } from "@openlife/core/audit";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type Row = Readonly<{ id: number; at: string; action: string; entity_id: string; request_id: string; ip: string | null; user_agent: string | null; details: string | null }>;

const placeholders = (count: number): string => Array.from({ length: count }, () => "?").join(", ");

/** The WHERE of a kind: its entities and its single actions, without the actions that leave it. */
function whereOf(filter: NonNullable<AuditQuery["filter"]>): Readonly<{ sql: string; params: readonly string[] }> {
  const parts: string[] = [];
  const params: string[] = [];
  const members: string[] = [];
  if (filter.entities.length > 0) {
    members.push(`entity IN (${placeholders(filter.entities.length)})`);
    params.push(...filter.entities);
  }
  if (filter.actions.length > 0) {
    members.push(`action IN (${placeholders(filter.actions.length)})`);
    params.push(...filter.actions);
  }
  parts.push(members.length === 0 ? "0" : `(${members.join(" OR ")})`);
  if (filter.except.length > 0) {
    // An action that leaves the entities does not leave a kind that names it as a single action.
    const named = filter.actions.length > 0 ? `action IN (${placeholders(filter.actions.length)}) OR ` : "";
    if (named !== "") params.push(...filter.actions);
    parts.push(`(${named}action NOT IN (${placeholders(filter.except.length)}))`);
    params.push(...filter.except);
  }
  return { sql: parts.join(" AND "), params };
}

export function bindAuditLogReader(tx: TransactionHandle): AuditLogReader {
  const read = (sql: string, params: readonly (string | number)[]) => tx.prepare(sql).all(...params) as unknown as Row[];
  return {
    page: ({ filter, offset, limit }) => {
      const where = filter === null ? { sql: "1", params: [] as readonly string[] } : whereOf(filter);
      const total = (tx.prepare(`SELECT count(*) AS n FROM audit_log WHERE ${where.sql}`).get(...where.params) as { n: number }).n;
      const rows = read(
        `SELECT id, at, action, entity_id, request_id, ip, user_agent, details FROM audit_log WHERE ${where.sql} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset],
      );
      return {
        total,
        entries: rows.map(
          (row): AuditRecord => ({
            id: row.id,
            at: row.at,
            action: row.action,
            entityId: row.entity_id,
            requestId: row.request_id,
            ip: row.ip,
            userAgent: row.user_agent,
            details: row.details === null ? null : (JSON.parse(row.details) as AuditDetails),
          }),
        ),
      };
    },
  };
}
