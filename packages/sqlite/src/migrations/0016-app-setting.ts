// Migration 16 (D41.2): the application options the owner has changed (Architektura §4.2, §14.1). One
// row per option that differs from its default; no row means the default of the catalog. The value is
// JSON (a number, a boolean or a text) and is checked against the catalog before it is written and when
// it is read. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const APP_SETTING_MIGRATION: Migration = {
  version: 16,
  id: "0016-app-setting",
  sql: `CREATE TABLE app_setting (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 100),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL
) STRICT;
`,
  checksum: "d8216a3775a233d49bd9e233e7a092a810032bb8c5ad9aaf9d5a927c516333e4",
};
