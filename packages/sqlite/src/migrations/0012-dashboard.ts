// Migration 12 (D17.3): the screen of the owner, its widgets and their bindings (Architektura §4.2,
// §5.6, §18.5). A screen is replaced as one aggregate, so the tables hold what the owner designed and
// nothing derived but the last state of a widget; the state of a binding is not stored, because it
// is worked out against the catalog at every read. `position` keeps the order of the snapshot (the
// order of the widgets, and of the bindings of a widget), and is not unique, so two widgets can swap
// places in one write. A binding to a registry or a column is by identifier and has no foreign key:
// a deleted column stays a broken binding, never a missing row. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const DASHBOARD_MIGRATION: Migration = {
  version: 12,
  id: "0012-dashboard",
  sql: `CREATE TABLE screen (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id"),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  theme TEXT NOT NULL CHECK (theme IN ('dark')),
  accent TEXT NOT NULL CHECK (accent IN ('blue', 'green', 'violet', 'orange', 'pink', 'teal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX screen_by_owner ON screen (user_id, created_at);
CREATE TABLE widget (
  id TEXT PRIMARY KEY,
  screen_id TEXT NOT NULL REFERENCES screen (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 64),
  config TEXT NOT NULL CHECK (json_valid(config) AND json_type(config) IS 'object' AND length(config) <= 32768),
  layout TEXT NOT NULL CHECK (json_valid(layout) AND json_type(layout, '$.phone') IS 'object' AND json_type(layout, '$.tablet') IS 'object' AND json_type(layout, '$.desktop') IS 'object'),
  state TEXT NOT NULL CHECK (state IN ('draft', 'ok', 'needs_rebinding', 'needs_refresh'))
) STRICT;
CREATE INDEX widget_by_screen ON widget (screen_id, position);
CREATE TABLE binding (
  widget_id TEXT NOT NULL REFERENCES widget (id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 40),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  position INTEGER NOT NULL CHECK (position >= 0),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 300),
  target TEXT NOT NULL CHECK (json_valid(target) AND json_type(target) IS 'object' AND json_type(target, '$.kind') IS 'text' AND length(target) <= 1024),
  PRIMARY KEY (widget_id, slot, ordinal)
) STRICT;
CREATE INDEX binding_by_registry ON binding (json_extract(target, '$.registryId'));
`,
  checksum: "907dc9bcb8a246f2bc632b623ccd8c4e27cf1b39447b392bdec355cc44857112",
};
