// AuditRetention on the handle of a unit of work (Architektura §11.2; D44.5): the oldest entries before a
// moment, at most a given number, in the unit that records their removal. The adapter owns `audit_log`.
import type { AuditRetention } from "@openlife/core/audit";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindAuditRetention(tx: TransactionHandle): AuditRetention {
  // The oldest first (by time, then by id, which grows with the writes), so a bounded batch never skips an older entry.
  const remove = tx.prepare(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? ORDER BY at, id LIMIT ?)`);
  return { deleteOlderThan: (before, limit) => Number(remove.run(before, limit).changes) };
}
