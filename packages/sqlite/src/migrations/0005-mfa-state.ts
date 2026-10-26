// Migration 5 (D10.1): the one source of the second factor's state and the assurance of each
// session (Architektura §4.2, §9.6, §9.7). `mfa_state` is the owner's singleton: policy,
// enrollment stage, the encrypted TOTP secret with its generation, the last consumed time step
// (replay) and one pending enrollment. `session_ext` sits beside the auth adapter's `session`
// table; the library has no column for it and no endpoint that writes it, so a public update
// cannot raise assurance. Rows are created for an existing owner and sessions so that an
// installation migrated from migration 4 is consistent. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const MFA_STATE_MIGRATION: Migration = {
  version: 5,
  id: "0005-mfa-state",
  sql: `CREATE TABLE mfa_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL UNIQUE REFERENCES "user" ("id"),
  policy TEXT NOT NULL CHECK (policy IN ('required', 'disabled', 'reset_required')),
  enrollment_state TEXT NOT NULL CHECK (enrollment_state IN ('required', 'awaiting_recovery_ack', 'complete')),
  secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
  active_secret TEXT,
  last_used_step INTEGER,
  pending_challenge_id TEXT,
  pending_secret TEXT,
  pending_expires_at_ms INTEGER,
  CHECK ((active_secret IS NULL) = (secret_generation = 0)),
  CHECK ((pending_challenge_id IS NULL) = (pending_secret IS NULL) AND (pending_secret IS NULL) = (pending_expires_at_ms IS NULL))
) STRICT;
CREATE TABLE session_ext (
  session_id TEXT PRIMARY KEY REFERENCES "session" ("id") ON DELETE CASCADE,
  assurance TEXT NOT NULL CHECK (assurance IN ('password', 'totp', 'trusted', 'recovery')),
  password_verified_at_ms INTEGER NOT NULL,
  totp_verified_at_ms INTEGER,
  access_epoch INTEGER NOT NULL CHECK (access_epoch >= 1),
  CHECK (assurance <> 'totp' OR totp_verified_at_ms IS NOT NULL)
) STRICT;
INSERT INTO mfa_state (singleton, owner_id, policy, enrollment_state, secret_generation)
  SELECT 1, owner_id, 'required', 'required', 0 FROM instance_state;
INSERT INTO session_ext (session_id, assurance, password_verified_at_ms, access_epoch)
  SELECT s.id, 'password', CAST(strftime('%s', s.createdAt) AS INTEGER) * 1000, o.access_epoch
    FROM "session" s JOIN instance_state o ON o.owner_id = s.userId;
DELETE FROM "session" WHERE id NOT IN (SELECT session_id FROM session_ext);
`,
  checksum: "96835442ba4415909ad0266170a050e6785a465557862d894410845499c5b925",
};
