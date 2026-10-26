// Migration 6 (D10.2): the owner's one-time choice of the starting data (Architektura §9.7,
// §18.7), read by the access policy. It lives on the installation's singleton; the atomic write
// of the choice arrives with the setup backend (D11.4). Released migrations are never edited.
import type { Migration } from "./migration.js";

export const SETUP_DATA_CHOICE_MIGRATION: Migration = {
  version: 6,
  id: "0006-setup-data-choice",
  sql: `ALTER TABLE instance_state ADD COLUMN data_choice TEXT NOT NULL DEFAULT 'unselected' CHECK (data_choice IN ('unselected', 'empty', 'imported'));
`,
  checksum: "0f94d9d689f6de94bda718754154439abe1c5831cfbad2ed529ba07a154e39a6",
};
