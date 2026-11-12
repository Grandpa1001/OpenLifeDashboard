// Migration 17 (D43.2): the name a trusted device shows in the list of the Security page (Scope §5.9). It is
// the browser the owner trusted, as the browser called itself, cut to 200 characters; a device trusted before
// this migration has none and the page names it as unknown. Released migrations are never edited.
import type { Migration } from "./migration.js";

export const TRUSTED_DEVICE_LABEL_MIGRATION: Migration = {
  version: 17,
  id: "0017-trusted-device-label",
  sql: `ALTER TABLE trusted_device ADD COLUMN label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 200);
`,
  checksum: "3df781aacd6d230bb9c174eb189c02b8c1d0ef35f76877c7e1ee81d65b95839e",
};
