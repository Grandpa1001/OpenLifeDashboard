// MfaStore on the handle of a unit of work (Architektura §4.2, §9.6, §9.7; D10.1): the one place
// of the second factor's state. Secrets arrive and leave as the envelopes of the server's secret
// box; this adapter never holds a key. Every transition that must not race is a compare-and-set
// in one statement.
import type { MfaRecord, MfaStore } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type Row = Readonly<{
  policy: MfaRecord["policy"];
  enrollment_state: MfaRecord["enrollmentState"];
  secret_generation: number;
  active_secret: string | null;
  last_used_step: number | null;
  pending_challenge_id: string | null;
  pending_secret: string | null;
  pending_expires_at_ms: number | null;
  pending_session_id: string | null;
  recovery_batch_id: string | null;
  recovery_batch_session_id: string | null;
}>;

export function bindMfaStore(tx: TransactionHandle): MfaStore {
  const initialize = tx.prepare(
    "INSERT INTO mfa_state (singleton, owner_id, policy, enrollment_state, secret_generation) VALUES (1, ?, 'required', 'required', 0)",
  );
  const read = tx.prepare("SELECT * FROM mfa_state");
  // Only while no secret is active and the generation is the one the caller saw.
  const savePending = tx.prepare(
    `UPDATE mfa_state SET pending_challenge_id = ?, pending_secret = ?, pending_expires_at_ms = ?, pending_session_id = ?
      WHERE singleton = 1 AND enrollment_state = 'required' AND secret_generation = ?`,
  );
  const activate = tx.prepare(
    `UPDATE mfa_state
        SET active_secret = pending_secret, secret_generation = secret_generation + 1, last_used_step = ?,
            policy = 'required', enrollment_state = 'awaiting_recovery_ack',
            pending_challenge_id = NULL, pending_secret = NULL, pending_expires_at_ms = NULL, pending_session_id = NULL
      WHERE singleton = 1 AND pending_challenge_id = ? AND pending_session_id = ? AND pending_expires_at_ms > ? AND secret_generation = ?`,
  );
  const reset = tx.prepare(
    `UPDATE mfa_state
        SET policy = 'reset_required', enrollment_state = 'required', secret_generation = 0, active_secret = NULL, last_used_step = NULL,
            pending_challenge_id = NULL, pending_secret = NULL, pending_expires_at_ms = NULL, pending_session_id = NULL,
            recovery_batch_id = NULL, recovery_batch_session_id = NULL
      WHERE singleton = 1`,
  );
  const consume = tx.prepare(
    `UPDATE mfa_state SET last_used_step = ?
      WHERE singleton = 1 AND secret_generation = ? AND secret_generation > 0 AND (last_used_step IS NULL OR last_used_step < ?)`,
  );
  return {
    initialize: (ownerId) => void initialize.run(ownerId),
    read: () => {
      const row = read.get() as Row | undefined;
      if (row === undefined) {
        return null;
      }
      return {
        policy: row.policy,
        enrollmentState: row.enrollment_state,
        secretGeneration: row.secret_generation,
        activeSecret: row.active_secret,
        lastUsedStep: row.last_used_step,
        pending:
          row.pending_challenge_id === null || row.pending_secret === null || row.pending_expires_at_ms === null || row.pending_session_id === null
            ? null
            : { challengeId: row.pending_challenge_id, secret: row.pending_secret, expiresAtMs: row.pending_expires_at_ms, sessionId: row.pending_session_id },
        recoveryBatch:
          row.recovery_batch_id === null || row.recovery_batch_session_id === null
            ? null
            : { batchId: row.recovery_batch_id, sessionId: row.recovery_batch_session_id },
      };
    },
    consumeStep: ({ expectedGeneration, step }) => consume.run(step, expectedGeneration, step).changes === 1,
    resetFactor: () => void reset.run(),
    savePending: ({ challengeId, secret, expiresAtMs, sessionId, expectedGeneration }) =>
      savePending.run(challengeId, secret, expiresAtMs, sessionId, expectedGeneration).changes === 1,
    activatePending: ({ challengeId, sessionId, expectedGeneration, usedStep, nowMs }) =>
      activate.run(usedStep, challengeId, sessionId, nowMs, expectedGeneration).changes === 1,
  };
}
