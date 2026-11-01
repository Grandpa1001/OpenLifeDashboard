// Migration 13 (D24.1): the dictionaries of the owner and their values (Architektura §4.2, §4.3,
// §5.2). A record of a registry keeps the symbol of a value as text, with no foreign key to these
// tables: a value or a dictionary that goes leaves every record as it was. A value is known by its
// symbol, unique in its dictionary; `position` is the order of the list and `hidden` takes a value
// out of the choice of new records only. A dictionary is deleted with its values (no data of its own
// to keep), and its symbol is free again. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const DICTIONARIES_MIGRATION: Migration = {
  version: 13,
  id: "0013-dictionaries",
  sql: `CREATE TABLE dictionary (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id"),
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 40 AND symbol NOT GLOB '*[^a-z0-9_]*' AND symbol GLOB '[a-z]*' AND symbol NOT GLOB '*__*' AND symbol NOT GLOB '*_'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, symbol)
) STRICT;
CREATE TABLE dictionary_value (
  id TEXT PRIMARY KEY,
  dictionary_id TEXT NOT NULL REFERENCES dictionary (id) ON DELETE CASCADE,
  symbol TEXT NOT NULL CHECK (length(symbol) BETWEEN 1 AND 40 AND symbol NOT GLOB '*[^a-z0-9_]*' AND symbol GLOB '[a-z]*' AND symbol NOT GLOB '*__*' AND symbol NOT GLOB '*_'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  position INTEGER NOT NULL CHECK (position >= 0),
  hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
  UNIQUE (dictionary_id, symbol)
) STRICT;
CREATE INDEX dictionary_value_by_dictionary ON dictionary_value (dictionary_id, position);
`,
  checksum: "412db76fdebf24b72b890ffd05f7ca7f8c3407997700627be8096ae19059d2ba",
};
