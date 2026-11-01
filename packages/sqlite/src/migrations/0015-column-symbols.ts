// Migration 15 (D28.1): the symbol of a column is unique among the active columns of its registry,
// not among every column it ever had (Architektura §5.2, Scope §5.6). A removed column keeps its row
// in the catalog, so a binding to it is broken rather than unknown, but it frees its symbol: adding
// the column again makes a new column with a new identifier, and the old bindings still point at the
// removed one. SQLite cannot drop a table constraint, so the catalog of columns is copied into a
// table without it, row for row, and a partial unique index takes its place. Nothing references the
// table by a foreign key. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const COLUMN_SYMBOLS_MIGRATION: Migration = {
  version: 15,
  id: "0015-column-symbols",
  sql: `CREATE TABLE registry_column_v15 (
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
  deleted_at TEXT
) STRICT;
INSERT INTO registry_column_v15 (id, registry_id, symbol, display_name, type, type_options, default_value, required, position, created_at, deleted_at)
  SELECT id, registry_id, symbol, display_name, type, type_options, default_value, required, position, created_at, deleted_at FROM registry_column;
DROP TABLE registry_column;
ALTER TABLE registry_column_v15 RENAME TO registry_column;
CREATE INDEX registry_column_by_registry ON registry_column (registry_id, position);
CREATE UNIQUE INDEX registry_column_active_symbol ON registry_column (registry_id, symbol) WHERE deleted_at IS NULL;
`,
  checksum: "139c704673c505af9b8b8559a49ba8f26c975a0b33782d5721e0583b3707b281",
};
