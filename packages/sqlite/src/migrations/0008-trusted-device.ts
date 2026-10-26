// Migration 8 (D11.2): trusted devices (Architektura §9.3, §9.7). Only the hash of the device
// token is stored; the expiry is fixed at creation and never extended; revoking sets a time.
// A session that was granted because of a device points to it, so the device's expiry or
// revocation takes that session's data access away. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const TRUSTED_DEVICE_MIGRATION: Migration = {
  version: 8,
  id: "0008-trusted-device",
  sql: `CREATE TABLE trusted_device (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER
) STRICT;
ALTER TABLE session_ext ADD COLUMN trusted_device_id TEXT REFERENCES trusted_device (id);
`,
  checksum: "5d1b81af858005e0daea4b293d5446113dcd2b93b7173587a451ad81b692603c",
};
