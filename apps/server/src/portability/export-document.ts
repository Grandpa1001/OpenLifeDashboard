// The export document (Architektura Załącznik G; D45.2), written as a stream of text from the stores of a
// consistent view. The file is one JSON document of the format v1: the settings of the owner, the entries of
// ConfigTable, the dictionaries, the registries with their structure and records, and the screens. A registry's
// records are read a page at a time by the order of their identifiers and written as they are read, and
// between two pages the event loop is given back, so a large registry is never held in memory and the
// requests of the owner (and the live stream) are served while the file is made. Nothing of the
// authentication, the audit, the catalog of copies, the flags of the application or a `user_id` is read.
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, type ExportFile } from "@openlife/contracts/export/format";
import { DEFAULT_DATE_FORMAT } from "@openlife/contracts/http/setup";
import { SOURCE_LOCALE } from "@openlife/contracts/locales";
import type { ConfigStore } from "@openlife/core/configuration";
import type { DashboardStore } from "@openlife/core/dashboard";
import type { DictionaryStore } from "@openlife/core/dictionaries";
import type { RecordStore, RegistryStore, StoredRecord, StoredRegistry } from "@openlife/core/registries";
import type { OwnerPreferences } from "@openlife/core/settings";

/** What the export reads: the stores of the modules, bound to one consistent view. */
export type ExportReadPorts = Readonly<{
  ownerId: string;
  preferences: OwnerPreferences | null;
  config: Pick<ConfigStore, "list">;
  dictionaries: Pick<DictionaryStore, "list">;
  registries: Pick<RegistryStore, "list">;
  records: Pick<RecordStore, "pageAfter">;
  dashboard: Pick<DashboardStore, "list" | "find">;
}>;

export type ExportDocumentOptions = Readonly<{
  appVersion: string;
  exportedAt: Date;
  /** Records read and written at a time. */
  recordsPerPage: number;
  /** Gives the event loop back between two pages. */
  yieldToLoop: () => Promise<void>;
}>;

type ExportRegistry = ExportFile["registries"][number];
type ExportRecord = ExportRegistry["records"][number];

/** One value of an array on its own line: the file reads as a list of lines, and a record is one of them. */
const line = (value: unknown): string => JSON.stringify(value);

function recordOf(registry: StoredRegistry, record: StoredRecord): ExportRecord {
  // Every column of the registry is in the record, an empty value as null; a value of a column that was removed is not.
  const values: Record<string, ExportRecord["values"][string]> = {};
  for (const column of registry.columns) values[column.symbol] = record.values[column.symbol] ?? null;
  return { id: record.id, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, values };
}

/** The structure of a registry without its records; the columns are numbered in their order, which is what the file requires. */
function registryHead(registry: StoredRegistry): Omit<ExportRegistry, "records"> {
  return {
    id: registry.id,
    symbol: registry.symbol,
    displayName: registry.displayName,
    schemaRevision: registry.schemaRevision,
    dataRevision: registry.dataRevision,
    columns: registry.columns.map((column, position) => ({
      id: column.id,
      symbol: column.symbol,
      displayName: column.displayName,
      type: column.type,
      typeOptions: column.typeOptions,
      defaultValue: column.defaultValue,
      required: column.required,
      position,
    })),
  };
}

export async function* exportDocument(ports: ExportReadPorts, options: ExportDocumentOptions): AsyncGenerator<string> {
  const { ownerId } = ports;
  const settings = ports.preferences ?? { timezone: "UTC", locale: SOURCE_LOCALE, dateFormat: DEFAULT_DATE_FORMAT };
  yield `{\n"format": ${line(EXPORT_FORMAT)},\n"formatVersion": ${EXPORT_FORMAT_VERSION},\n"appVersion": ${line(options.appVersion)},\n"exportedAt": ${line(options.exportedAt.toISOString())},\n"settings": ${line(settings)},\n`;

  const configEntries = ports.config.list(ownerId).map((entry) => ({ id: entry.id, symbol: entry.symbol, displayName: entry.displayName, value: entry.value, description: entry.description }));
  yield `"configEntries": [\n${configEntries.map(line).join(",\n")}\n],\n`;

  const dictionaries = ports.dictionaries.list(ownerId).map((dictionary) => ({
    id: dictionary.id,
    symbol: dictionary.symbol,
    displayName: dictionary.displayName,
    values: dictionary.values.map((value, position) => ({ id: value.id, symbol: value.symbol, label: value.label, position, hidden: value.hidden })),
  }));
  yield `"dictionaries": [\n${dictionaries.map(line).join(",\n")}\n],\n`;

  yield `"registries": [\n`;
  const registries = ports.registries.list(ownerId);
  for (const [index, registry] of registries.entries()) {
    // The head of the registry, then its records a page at a time; the object is closed after the last page.
    const head = line(registryHead(registry));
    yield `${index === 0 ? "" : ",\n"}${head.slice(0, -1)},\n"records": [\n`;
    let after: string | null = null;
    let first = true;
    for (;;) {
      const page = ports.records.pageAfter(registry, after, options.recordsPerPage);
      if (page.length === 0) break;
      yield `${first ? "" : ",\n"}${page.map((record) => line(recordOf(registry, record))).join(",\n")}`;
      first = false;
      after = page[page.length - 1]?.id ?? null;
      if (page.length < options.recordsPerPage) break;
      await options.yieldToLoop();
    }
    yield `\n]}`;
  }
  yield `\n],\n`;

  const screens = ports.dashboard.list(ownerId).flatMap((summary) => {
    const screen = ports.dashboard.find(ownerId, summary.id);
    return screen === null
      ? []
      : [
          {
            id: screen.id,
            name: screen.name,
            theme: screen.theme,
            accent: screen.accent,
            widgets: screen.widgets.map((widget) => ({ id: widget.id, type: widget.type, config: widget.config, layout: widget.layout, bindings: widget.bindings })),
          },
        ];
  });
  yield `"screens": [\n${screens.map(line).join(",\n")}\n]\n}\n`;
}
