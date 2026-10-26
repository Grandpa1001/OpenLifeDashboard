// RecoveryCodeStore on the handle of a unit of work (Architektura §9.7; D11.1): hashes of the
// recovery codes in batches, one current batch named by `mfa_state`, bound to the session that was
// shown the codes. Issuing a batch removes every older row, so an old code cannot be found; the
// acknowledgment is a compare-and-set on the batch and the session.
import type { RecoveryCodeStore } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

export function bindRecoveryCodeStore(tx: TransactionHandle): RecoveryCodeStore {
  const clear = tx.prepare("DELETE FROM recovery_code");
  const insert = tx.prepare("INSERT INTO recovery_code (batch_id, position, code_hash) VALUES (?, ?, ?)");
  const current = tx.prepare("UPDATE mfa_state SET recovery_batch_id = ?, recovery_batch_session_id = ?, enrollment_state = 'awaiting_recovery_ack' WHERE singleton = 1");
  const acknowledge = tx.prepare(
    `UPDATE mfa_state SET enrollment_state = 'complete'
      WHERE singleton = 1 AND enrollment_state = 'awaiting_recovery_ack' AND recovery_batch_id = ? AND recovery_batch_session_id = ?`,
  );
  const state = tx.prepare("SELECT enrollment_state AS state, recovery_batch_id AS batchId FROM mfa_state WHERE singleton = 1");
  const consume = tx.prepare("UPDATE recovery_code SET used_at_ms = ? WHERE code_hash = ? AND used_at_ms IS NULL");
  const remaining = tx.prepare("SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL");
  return {
    issueBatch: ({ batchId, sessionId, hashes }) => {
      clear.run();
      hashes.forEach((hash, index) => void insert.run(batchId, index + 1, hash));
      current.run(batchId, sessionId);
    },
    acknowledge: ({ batchId, sessionId }) => {
      if (acknowledge.run(batchId, sessionId).changes === 1) {
        return "acknowledged";
      }
      const row = state.get() as { state: string; batchId: string | null } | undefined;
      if (row?.state !== "awaiting_recovery_ack") {
        return "not_awaited";
      }
      return "batch_changed";
    },
    consume: ({ hash, nowMs }) => (consume.run(nowMs, hash).changes === 1 ? { remaining: (remaining.get() as { n: number }).n } : null),
  };
}
