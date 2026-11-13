// Loads the F01 fixture (tests/fixtures/books/books-v1.export.json) into the database of the harness with the
// identifiers, revisions and times it names, through the ports of the stores: a test-only stand-in for the
// import of D46, so that the export of a state can be compared with the file that describes it. It writes as
// the production stores do (the revision of the data of a registry counts the records it was given).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExportFile } from "../../packages/contracts/src/export/format.ts";
import type { AppHarness } from "./app-harness.ts";
import { repoRoot } from "./server-process.ts";

export const F01_TEXT = readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8");
export const F01 = JSON.parse(F01_TEXT) as ExportFile;

const OWNER_ID = "owner-1";
const AT = "2026-10-01T12:00:00Z";

export function loadFixture(h: AppHarness, file: ExportFile = F01): void {
  const result = h.elsewhere.run((ports) => {
    ports.preferences.write(OWNER_ID, file.settings, Date.parse(AT));
    for (const entry of file.configEntries) {
      ports.config.insert({ id: entry.id, ownerId: OWNER_ID, symbol: entry.symbol, content: { displayName: entry.displayName, value: entry.value, description: entry.description }, nowIso: AT });
    }
    for (const dictionary of file.dictionaries) {
      ports.dictionaries.insert({
        id: dictionary.id,
        ownerId: OWNER_ID,
        symbol: dictionary.symbol,
        content: { displayName: dictionary.displayName, values: dictionary.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })) },
        valueIds: dictionary.values.map((value) => value.id),
        nowIso: AT,
      });
    }
    for (const registry of file.registries) {
      ports.registries.insert({
        id: registry.id,
        ownerId: OWNER_ID,
        columnIds: registry.columns.map((column) => column.id),
        definition: {
          symbol: registry.symbol,
          displayName: registry.displayName,
          columns: registry.columns.map((column) => ({ symbol: column.symbol, displayName: column.displayName, type: column.type, typeOptions: { ...(column.typeOptions.decimalPlaces === undefined ? {} : { decimalPlaces: column.typeOptions.decimalPlaces }), ...(column.typeOptions.dictionaryId === undefined ? {} : { dictionaryId: column.typeOptions.dictionaryId }) }, defaultValue: column.defaultValue, required: column.required, position: column.position })),
        },
        nowIso: AT,
      });
      const stored = ports.registries.find(OWNER_ID, registry.symbol);
      if (stored === null) throw new Error("the registry was not stored");
      for (const record of registry.records) {
        ports.records.insert(stored, { id: record.id, registryId: registry.id, ownerId: OWNER_ID, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, values: record.values });
      }
    }
    for (const screen of file.screens) {
      ports.dashboard.create({ id: screen.id, ownerId: OWNER_ID, name: screen.name, theme: screen.theme, accent: screen.accent, nowIso: AT });
      ports.dashboard.replace(OWNER_ID, screen.id, { name: screen.name, theme: screen.theme, accent: screen.accent, widgets: screen.widgets.map((widget) => ({ ...widget, state: "ok" as const })) }, AT);
    }
    return { value: null, invalidations: [] };
  });
  if (!result.ok) throw new Error(`the fixture was not loaded: ${result.error.code}`);
}
