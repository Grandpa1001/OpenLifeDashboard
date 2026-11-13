// The import of the owner's data into an empty installation (Architektura Załącznik G, §9.7; D46.1): everything
// the file holds is written in ONE unit of work, so any failure, in a rule or in the database, takes back the
// whole of it, the tables of the registries among it, and leaves the installation as it was, with nothing
// chosen. The file has been validated as a whole before (the parser of the server); here only what the
// database must decide is decided: the access (the policy `setup_data_choice`, read again inside the unit)
// and the one-time choice of the starting data, which an import takes by compare-and-set, so two imports, or
// an import and a start from zero, cannot both win. The identifiers, the revisions and the times of the file
// are kept, the owner is the installation's own, and the state of every widget is worked out in the catalog
// the import has just made, which is how a binding to what the file does not hold becomes `needs_rebinding`
// and a type of this build's future `needs_refresh`, with its configuration kept as it came.
import type { AppendAudit } from "../../audit/public.js";
import type { ConfigStore } from "../../configuration/public.js";
import { stateOfStoredWidget, type DashboardCatalogReader, type DashboardStore, type DesignPolicy, type WidgetCatalogPort, type WidgetInput, type WidgetState } from "../../dashboard/public.js";
import type { DictionaryStore } from "../../dictionaries/public.js";
import { DomainFault, type Commit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore, type SetupStateStore } from "../../identity/public.js";
import type { CellValue, ColumnType, ColumnTypeOptions, RecordStore, RegistryStore } from "../../registries/public.js";
import type { OwnerPreferences, OwnerPreferencesStore } from "../../settings/public.js";

export type ImportedColumn = Readonly<{ id: string; symbol: string; displayName: string; type: ColumnType; typeOptions: ColumnTypeOptions; defaultValue: CellValue; required: boolean; position: number }>;
export type ImportedRecord = Readonly<{ id: string; revision: number; createdAt: string; updatedAt: string; values: Readonly<Record<string, CellValue>> }>;

/** What an export file holds, as the domain sees it; the owner, the authentication and the audit are not in it. */
export type ImportedData = Readonly<{
  settings: OwnerPreferences;
  configEntries: readonly Readonly<{ id: string; symbol: string; displayName: string; value: string; description: string }>[];
  dictionaries: readonly Readonly<{
    id: string;
    symbol: string;
    displayName: string;
    values: readonly Readonly<{ id: string; symbol: string; label: string; position: number; hidden: boolean }>[];
  }>[];
  registries: readonly Readonly<{
    id: string;
    symbol: string;
    displayName: string;
    schemaRevision: number;
    dataRevision: number;
    columns: readonly ImportedColumn[];
    records: readonly ImportedRecord[];
  }>[];
  screens: readonly Readonly<{ id: string; name: string; theme: string; accent: string; widgets: readonly WidgetInput[] }>[];
}>;

export type ImportPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  setup: SetupStateStore;
  preferences: OwnerPreferencesStore;
  config: ConfigStore;
  dictionaries: DictionaryStore;
  registries: RegistryStore;
  records: RecordStore;
  dashboard: DashboardStore;
  catalog: DashboardCatalogReader;
  audit: AppendAudit;
}>;

export type ImportDependencies = Readonly<{
  unit: UnitOfWork<ImportPorts>;
  nowMs: () => number;
  /** The limits of a design and the types this build has: they decide the state of each widget. */
  policy: DesignPolicy;
  widgets: WidgetCatalogPort;
}>;

export type ImportSummary = Readonly<{ configEntries: number; dictionaries: number; registries: number; records: number; screens: number; widgets: number }>;

/** True when a binding points at something the file does not hold: a registry, a column of a registry or an entry of ConfigTable that is not in it. */
function pointsAtNothing(binding: WidgetInput["bindings"][number], data: ImportedData): boolean {
  const target = binding.target;
  switch (target.kind) {
    case "registry":
    case "systemColumn":
      return !data.registries.some((registry) => registry.id === target.registryId);
    case "column":
      return !data.registries.some((registry) => registry.id === target.registryId && registry.columns.some((column) => column.id === target.columnId));
    case "config":
      return !data.configEntries.some((entry) => entry.id === target.entryId);
    default:
      return false;
  }
}

/**
 * The state of a widget the import stores. The catalog that is stored knows the columns that were removed
 * (as removed), a file knows only the columns that are there, so a binding to a column that is not in the
 * file would look like a defect of the widget; it is a broken binding, and the widget needs rebinding, while
 * a type this build lacks or a configuration that does not fit still needs a refresh.
 */
function stateOfImportedWidget(widget: WidgetInput, data: ImportedData, deps: ImportDependencies, context: Parameters<typeof stateOfStoredWidget>[1]): WidgetState {
  const state = stateOfStoredWidget(widget, context);
  if (state !== "needs_refresh" || !deps.widgets.has(widget.type)) return state;
  if (!widget.bindings.some((binding) => pointsAtNothing(binding, data))) return state;
  return deps.widgets.normalizeConfig(widget.type, widget.config).ok ? "needs_rebinding" : state;
}

export function importOwnerData(deps: ImportDependencies, token: string, data: ImportedData, requestId: string): Result<ImportSummary> {
  const nowMs = deps.nowMs();
  const nowIso = new Date(nowMs).toISOString();
  const result = deps.unit.run((ports) => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) throw new DomainFault({ code: "AUTH_REQUIRED" });
    const decision = decideAccess(access.snapshot, "setup_data_choice", nowMs);
    if (!decision.allow) throw new DomainFault({ code: decision.code });
    const ownerId = access.session.ownerId;
    // The one-time choice first: the rest is written only by the request that won it.
    if (ports.setup.chooseImported() !== "chosen") throw new DomainFault({ code: "SETUP_DATA_ALREADY_CHOSEN" });

    ports.preferences.write(ownerId, data.settings, nowMs);
    for (const entry of data.configEntries) {
      ports.config.insert({ id: entry.id, ownerId, symbol: entry.symbol, content: { displayName: entry.displayName, value: entry.value, description: entry.description }, nowIso });
    }
    for (const dictionary of data.dictionaries) {
      ports.dictionaries.insert({
        id: dictionary.id,
        ownerId,
        symbol: dictionary.symbol,
        content: { displayName: dictionary.displayName, values: dictionary.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })) },
        valueIds: dictionary.values.map((value) => value.id),
        nowIso,
      });
    }
    let records = 0;
    for (const registry of data.registries) {
      ports.registries.insert({
        id: registry.id,
        ownerId,
        columnIds: registry.columns.map((column) => column.id),
        definition: {
          symbol: registry.symbol,
          displayName: registry.displayName,
          columns: registry.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required, position }) => ({ symbol, displayName, type, typeOptions, defaultValue, required, position })),
        },
        nowIso,
      });
      const stored = ports.registries.find(ownerId, registry.symbol);
      if (stored === null) throw new TypeError("the registry that was just made is not there");
      for (const record of registry.records) {
        ports.records.insert(stored, { id: record.id, registryId: registry.id, ownerId, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, values: record.values });
        records += 1;
      }
      // Each insert counted a revision of the data; the file says what they were.
      ports.registries.restoreRevisions(stored, registry.schemaRevision, registry.dataRevision);
    }
    let widgets = 0;
    for (const screen of data.screens) {
      ports.dashboard.create({ id: screen.id, ownerId, name: screen.name, theme: screen.theme, accent: screen.accent, nowIso });
      const context = { ownerId, screenId: screen.id, policy: deps.policy, widgets: deps.widgets, catalog: ports.catalog };
      ports.dashboard.replace(ownerId, screen.id, { name: screen.name, theme: screen.theme, accent: screen.accent, widgets: screen.widgets.map((widget) => ({ ...widget, state: stateOfImportedWidget(widget, data, deps, context) })) }, nowIso);
      widgets += screen.widgets.length;
    }

    const summary: ImportSummary = { configEntries: data.configEntries.length, dictionaries: data.dictionaries.length, registries: data.registries.length, records, screens: data.screens.length, widgets };
    // Counts only: nothing the file held is in the audit.
    ports.audit.append({ ownerId, action: "setup.data_imported", entityId: ownerId, at: nowIso, requestId, details: { ...summary } });
    return { value: summary, invalidations: [] } satisfies Commit<ImportSummary>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
