// AppendAudit on the handle of a unit of work (Architektura §4.2, §18.1): the entry commits or
// rolls back with the change it records. The adapter owns `audit_log` and nothing else.
import type { AppendAudit } from "@openlife/core/audit";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

/** `<entity>.<event>`: the entity is the part before the first dot. */
function entityOf(action: string): string {
  const dot = action.indexOf(".");
  if (dot < 1 || dot === action.length - 1) {
    throw new TypeError("audit action must be <entity>.<event>");
  }
  return action.slice(0, dot);
}

export function bindAppendAudit(tx: TransactionHandle): AppendAudit {
  const insert = tx.prepare(
    `INSERT INTO audit_log (at, actor, action, entity, entity_id, request_id, ip, user_agent, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    append: (entry) => {
      insert.run(
        entry.at,
        entry.ownerId,
        entry.action,
        entityOf(entry.action),
        entry.entityId,
        entry.requestId,
        entry.ip ?? null,
        entry.userAgent ?? null,
        entry.details === undefined ? null : JSON.stringify(entry.details),
      );
    },
  };
}
