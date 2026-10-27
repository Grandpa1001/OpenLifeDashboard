// Migration 9 (D11.4): the owner's personal settings (Architektura §4.2, §14.2). One row for the
// single owner: the time zone and the language chosen in the first setup, and the date format
// that keeps its default until the settings screen (D41). Released migrations are never edited.
import type { Migration } from "./migration.js";

export const OWNER_SETTINGS_MIGRATION: Migration = {
  version: 9,
  id: "0009-owner-settings",
  sql: `CREATE TABLE owner_settings (
  owner_id TEXT PRIMARY KEY REFERENCES "user" ("id"),
  timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  locale TEXT NOT NULL CHECK (locale IN ('pl', 'en')),
  date_format TEXT NOT NULL DEFAULT 'DD.MM.YYYY',
  updated_at_ms INTEGER NOT NULL
) STRICT;
`,
  checksum: "b1ed91250ef2b22eb8f1aa93059842f880bf554ee5e4b64a8d35e75857c71a4c",
};
