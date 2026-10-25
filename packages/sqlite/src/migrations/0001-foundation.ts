// Migration 1 (D04.3): the migration manifest and the installation identity. Released
// migrations are never edited; a change of schema is a new migration (Architektura §4.8).
import type { Migration } from "./migration.js";

export const FOUNDATION_MIGRATION: Migration = {
  version: 1,
  id: "0001-foundation",
  sql: `CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  id TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE instance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`,
  checksum: "ad6f22a8902dc6f1da1c9f2df4d300c983799610ad253663ab908290b3453959",
};
