// Migration 10 (D14.2): the catalog of the user's registries (Architektura §4.2, §4.3, §5.1).
// `registry` and `registry_column` describe a registry; its records live in the table `reg_<symbol>`
// that the engine creates in the same transaction as the catalog rows, never by a migration
// (§4.1). The symbol is permanent and stays reserved after `deleted_at` is set, so it is unique
// over live and deleted registries alike. `default_value` and `type_options` are JSON. Required is
// the engine's rule on the catalog, not a NOT NULL of the table, so a change of it needs no DDL.
// Released migrations are never edited.
import type { Migration } from "./migration.js";

export const REGISTRIES_MIGRATION: Migration = {
  version: 10,
  id: "0010-registries",
  sql: `CREATE TABLE registry (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id"),
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 40 AND symbol NOT GLOB '*[^a-z0-9_]*' AND symbol GLOB '[a-z]*' AND symbol NOT GLOB '*__*' AND symbol NOT GLOB '*_'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  table_name TEXT NOT NULL CHECK (table_name = 'reg_' || symbol),
  schema_revision INTEGER NOT NULL DEFAULT 1 CHECK (schema_revision >= 1),
  data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (user_id, symbol)
) STRICT;
CREATE TABLE registry_column (
  id TEXT PRIMARY KEY,
  registry_id TEXT NOT NULL REFERENCES registry (id),
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 40 AND symbol NOT GLOB '*[^a-z0-9_]*' AND symbol GLOB '[a-z]*' AND symbol NOT GLOB '*__*' AND symbol NOT GLOB '*_'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'money', 'date', 'datetime', 'time', 'boolean', 'choice')),
  type_options TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(type_options)),
  default_value TEXT CHECK (default_value IS NULL OR json_valid(default_value)),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (registry_id, symbol)
) STRICT;
CREATE INDEX registry_column_by_registry ON registry_column (registry_id, position);
`,
  checksum: "3dbdbd77585442f2b6a911feaa644c958cfa19c8f6e1488398ccceadcc9b353e",
};
