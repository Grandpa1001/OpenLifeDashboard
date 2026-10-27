// Migration 11 (D15.2): the idempotency entries of commands that must not run twice (Architektura
// §4.6). An entry is bound to the owner, the operation and the key the client chose; it keeps the
// hash of the canonical input, so the same key with another input is a conflict, and the answer
// that was given, so a repeat gets the same answer. It is written in the unit of the command, so it
// commits or rolls back together with the record. Entries live for a retention the use case sets
// (`expires_at`); the index lets the expired ones be removed without a scan. Released migrations
// are never edited.
import type { Migration } from "./migration.js";

export const IDEMPOTENCY_MIGRATION: Migration = {
  version: 11,
  id: "0011-idempotency",
  sql: `CREATE TABLE idempotency_entry (
  owner_id TEXT NOT NULL REFERENCES "user" ("id"),
  operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 80),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response TEXT NOT NULL CHECK (json_valid(response)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (owner_id, operation, key)
) STRICT;
CREATE INDEX idempotency_entry_by_expiry ON idempotency_entry (expires_at);
`,
  checksum: "192e31257c9755bbef2f36c1bba39d2c6d850199d8285da5d685236dbe052079",
};
