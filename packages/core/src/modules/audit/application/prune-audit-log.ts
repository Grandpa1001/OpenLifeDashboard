// The retention of the audit log (Architektura §11.2; D44.5): the entries older than `audit.retentionDays`
// are removed, the oldest first and a bounded number at a time, so a unit of work is short and the requests of
// the owner are served between the batches. Each batch that removed something records itself in the same
// unit: the number removed and the retention, never a word of what was removed. A batch that removed
// nothing writes nothing, so the entry of the retention is not itself a reason for another.
import type { Commit, Result, UnitOfWork } from "../../../foundation/public.js";
import type { AppendAudit, AuditRetention } from "../ports.js";

export type AuditPrunePorts = Readonly<{ audit: AppendAudit; auditRetention: AuditRetention }>;
export type AuditPruneDependencies = Readonly<{ unit: UnitOfWork<AuditPrunePorts>; nowMs: () => number }>;
export type AuditPruneInput = Readonly<{
  retentionDays: number;
  /** The most entries one call removes. */
  batchRows: number;
  /** Names the batch in the audit and the log; it is not a request. */
  operationId: string;
}>;
export type AuditPruned = Readonly<{ deleted: number }>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The audit entry of a batch: an action of the installation, not of an owner. */
const PRUNED_ACTION = "audit.pruned";

export function pruneAuditLog(deps: AuditPruneDependencies, input: AuditPruneInput): Result<AuditPruned> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || !Number.isInteger(input.batchRows) || input.batchRows < 1) {
    return { ok: false, error: { code: "VALIDATION_FAILED" } };
  }
  const nowMs = deps.nowMs();
  const before = new Date(nowMs - input.retentionDays * DAY_MS).toISOString();
  const result = deps.unit.run((ports) => {
    const deleted = ports.auditRetention.deleteOlderThan(before, input.batchRows);
    if (deleted > 0) {
      ports.audit.append({ ownerId: null, action: PRUNED_ACTION, entityId: "audit", at: new Date(nowMs).toISOString(), requestId: input.operationId, details: { deleted, retentionDays: input.retentionDays } });
    }
    return { value: { deleted }, invalidations: [] } satisfies Commit<AuditPruned>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
