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
}>;

export function bindMfaStore(tx: TransactionHandle): MfaStore {
  const initialize = tx.prepare(
    "INSERT INTO mfa_state (singleton, owner_id, policy, enrollment_state, secret_generation) VALUES (1, ?, 'required', 'required', 0)",
  );
  const read = tx.prepare("SELECT * FROM mfa_state");
  const savePending = tx.prepare(
    "UPDATE mfa_state SET pending_challenge_id = ?, pending_secret = ?, pending_expires_at_ms = ? WHERE singleton = 1",
  );
  const activate = tx.prepare(
    `UPDATE mfa_state
        SET active_secret = pending_secret, secret_generation = secret_generation + 1, last_used_step = ?,
            enrollment_state = 'awaiting_recovery_ack',
            pending_challenge_id = NULL, pending_secret = NULL, pending_expires_at_ms = NULL
      WHERE singleton = 1 AND pending_challenge_id = ? AND pending_expires_at_ms > ? AND secret_generation = ?`,
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
          row.pending_challenge_id === null || row.pending_secret === null || row.pending_expires_at_ms === null
            ? null
            : { challengeId: row.pending_challenge_id, secret: row.pending_secret, expiresAtMs: row.pending_expires_at_ms },
      };
    },
    consumeStep: ({ expectedGeneration, step }) => consume.run(step, expectedGeneration, step).changes === 1,
    savePending: ({ challengeId, secret, expiresAtMs }) => void savePending.run(challengeId, secret, expiresAtMs),
    activatePending: ({ challengeId, expectedGeneration, usedStep, nowMs }) => activate.run(usedStep, challengeId, nowMs, expectedGeneration).changes === 1,
  };
}
