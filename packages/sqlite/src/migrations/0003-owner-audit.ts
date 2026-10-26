// Migration 3 (D09.2): the owner singleton and the audit trail, both needed before the first
// login (Architektura §4.2, §9.8). `instance_state` holds at most one row; its owner is the only
// owner, whatever else sits in the provider's user table. `audit_log` is the application's own
// table: the actor is null before an owner exists, `entity` is the part of the action before
// the dot, and details are JSON text without secrets. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const OWNER_AUDIT_MIGRATION: Migration = {
  version: 3,
  id: "0003-owner-audit",
  sql: `CREATE TABLE instance_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_id TEXT NOT NULL UNIQUE REFERENCES "user" ("id"),
  access_epoch INTEGER NOT NULL CHECK (access_epoch >= 1),
  owner_created_at TEXT NOT NULL
) STRICT;
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  details TEXT CHECK (details IS NULL OR json_valid(details))
) STRICT;
CREATE INDEX audit_log_at_idx ON audit_log (at);
`,
  checksum: "0f0a7fcc2643e135a440f61ef60481ccb182f421c8639104bd593873c41fc430",
};
