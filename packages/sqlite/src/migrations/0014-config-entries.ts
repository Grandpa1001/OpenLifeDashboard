// Migration 14 (D25.1): the entries of ConfigTable (Architektura §4.2, §5.3, §14.1). An entry is
// the owner's text: `value` is kept exactly as it was sent, never trimmed or typed, and the bound on
// it is the top of the range of `limits.textLength` (§14.2), so a later, higher limit needs no new
// migration; the rules hold the effective one. A binding points at an entry by its identifier and
// has no foreign key: a deleted entry leaves a broken binding, never a missing row. An entry is
// deleted outright and its symbol is free again. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const CONFIG_ENTRIES_MIGRATION: Migration = {
  version: 14,
  id: "0014-config-entries",
  sql: `CREATE TABLE config_entry (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id"),
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 40 AND symbol NOT GLOB '*[^a-z0-9_]*' AND symbol GLOB '[a-z]*' AND symbol NOT GLOB '*__*' AND symbol NOT GLOB '*_'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  value TEXT NOT NULL CHECK (length(value) <= 100000),
  description TEXT NOT NULL CHECK (length(description) <= 500),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, symbol)
) STRICT;
`,
  checksum: "6ff3761641b60b3863d20b3d5986cecd896dcbbe67027be95a7b5fafa1ba8e27",
};
