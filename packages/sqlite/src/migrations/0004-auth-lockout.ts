// Migration 4 (D09.3): persistent failure buckets of password sign-in (Architektura §9.8). A
// bucket is keyed by a hash of the account or of the client IP, so the table holds neither an
// e-mail nor an address. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const AUTH_LOCKOUT_MIGRATION: Migration = {
  version: 4,
  id: "0004-auth-lockout",
  sql: `CREATE TABLE auth_lockout (
  bucket_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures >= 1),
  window_started_at_ms INTEGER NOT NULL,
  locked_until_ms INTEGER
) STRICT;
CREATE INDEX auth_lockout_window_idx ON auth_lockout (window_started_at_ms);
`,
  checksum: "adf20042b858a717670ab59259b9e4c28cf40e8d7ea131eb6d43e03f031d6d84",
};
