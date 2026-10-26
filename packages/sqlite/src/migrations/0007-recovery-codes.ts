// Migration 7 (D11.1): recovery codes as hashes in batches, and the bindings of an enrollment
// to the session that started or received it (Architektura §9.7). A batch is current when
// `mfa_state.recovery_batch_id` names it; issuing a new batch deletes the rows of the old one,
// so an old code can no longer be found. The plain codes are never stored, and the batch is
// tied to the session that was shown the codes: only that session can acknowledge it.
// Released migrations are never edited.
import type { Migration } from "./migration.js";

export const RECOVERY_CODES_MIGRATION: Migration = {
  version: 7,
  id: "0007-recovery-codes",
  sql: `CREATE TABLE recovery_code (
  batch_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64),
  used_at_ms INTEGER,
  PRIMARY KEY (batch_id, position)
) STRICT;
ALTER TABLE mfa_state ADD COLUMN pending_session_id TEXT;
ALTER TABLE mfa_state ADD COLUMN recovery_batch_id TEXT;
ALTER TABLE mfa_state ADD COLUMN recovery_batch_session_id TEXT;
`,
  checksum: "a016433f9c032fd0663526e6d69e7e4c43cb2fbcf423543c9960b3f458585dc6",
};
