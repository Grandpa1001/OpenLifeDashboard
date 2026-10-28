// The screen of the owner (Architektura §5.4, §6, §18.3, §18.5; D17.4): creating the first one,
// reading it, replacing its design as one aggregate, listing the types of widgets, and reading the
// data of a widget. Every operation reads the access policy again inside its unit of work. A design is
// checked whole before anything is written; the data of a widget is read from what was saved, never
// from what the client names.
import { DomainFault, type Commit, type Failure, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import type { AppendAudit } from "../../audit/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import { resolveSortColumn, type CellValue, type RecordStore, type RegistryStore, type StoredColumn, type StoredRegistry } from "../../registries/public.js";
import type { DesignInput, DesignPolicy, WidgetState } from "../domain/design.js";
import { isValidScreenName, stateOfStoredWidget, validateDesign, type DesignContext } from "../domain/design-rules.js";
import type { DashboardCatalogReader, DashboardStore, StoredScreen, StoredWidget, WidgetCatalogPort, WidgetTypeManifest } from "../ports.js";

export type DashboardPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  dashboard: DashboardStore;
  catalog: DashboardCatalogReader;
  registries: RegistryStore;
  records: RecordStore;
  audit: AppendAudit;
}>;

export type DashboardDependencies = Readonly<{
  unit: UnitOfWork<DashboardPorts> & ReadUnit<DashboardPorts>;
  nowMs: () => number;
  /** A new identifier (UUIDv7) for a screen. */
  newId: () => string;
  policy: DesignPolicy;
  widgets: WidgetCatalogPort;
}>;

/** What a new screen starts with: the one theme and the default accent (Załącznik H). */
export const NEW_SCREEN = { theme: "dark", accent: "blue" } as const;
/** The screens an owner may have in the MVP. */
export const SCREENS_PER_OWNER = 1;

export type ScreenView = Readonly<Omit<StoredScreen, "ownerId">>;

/** The gate of every operation: the session, then the access policy for private data; the owner or why not. */
function gate(ports: DashboardPorts, token: string, nowMs: number, requestId: string): Readonly<{ ok: true; ownerId: string }> | Readonly<{ ok: false; error: Failure }> {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
  const decision = decideAccess(access.snapshot, "data", nowMs);
  return decision.allow ? { ok: true, ownerId: access.session.ownerId } : { ok: false, error: { code: decision.code } };
}

const contextOf = (deps: DashboardDependencies, ports: DashboardPorts, ownerId: string, screenId: string): DesignContext => ({ ownerId, screenId, policy: deps.policy, widgets: deps.widgets, catalog: ports.catalog });

/** A stored screen with the state of each widget worked out against the catalog as it is now. */
function viewOf(screen: StoredScreen, context: DesignContext): ScreenView {
  return {
    id: screen.id,
    name: screen.name,
    theme: screen.theme,
    accent: screen.accent,
    createdAt: screen.createdAt,
    updatedAt: screen.updatedAt,
    widgets: screen.widgets.map((widget) => ({ ...widget, state: stateOfStoredWidget(widget, context) })),
  };
}

function run<T>(deps: DashboardDependencies, token: string, requestId: string, work: (ports: DashboardPorts, ownerId: string, nowIso: string) => T): Result<T> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<T> => {
    const opened = gate(ports, token, nowMs, requestId);
    if (!opened.ok) throw new DomainFault(opened.error);
    return { value: work(ports, opened.ownerId, new Date(nowMs).toISOString()), invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

function read<T>(deps: DashboardDependencies, token: string, requestId: string, work: (ports: DashboardPorts, ownerId: string) => Result<T>): Result<T> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<T> => {
    const opened = gate(ports, token, nowMs, requestId);
    return opened.ok ? work(ports, opened.ownerId) : { ok: false, error: opened.error };
  });
}

const notFound = (): DomainFault => new DomainFault({ code: "NOT_FOUND" });
const notFoundResult = (): Result<never> => ({ ok: false, error: { code: "NOT_FOUND" } });

/** The owner's first screen, empty. A second one is refused: the MVP has one. */
export function createScreen(deps: DashboardDependencies, token: string, name: string, requestId: string): Result<ScreenView> {
  return run(deps, token, requestId, (ports, ownerId, nowIso) => {
    if (!isValidScreenName(name, deps.policy)) {
      throw new DomainFault({ code: "VALIDATION_FAILED", fields: ["name"], issues: [{ path: "name", code: "NAME_INVALID" }] });
    }
    if (ports.dashboard.count(ownerId) >= SCREENS_PER_OWNER) throw new DomainFault({ code: "SCREEN_LIMIT_EXCEEDED" });
    const id = deps.newId();
    ports.dashboard.create({ id, ownerId, name: name.trim(), theme: NEW_SCREEN.theme, accent: NEW_SCREEN.accent, nowIso });
    ports.audit.append({ ownerId, action: "screen.created", entityId: id, at: nowIso, requestId });
    const created = ports.dashboard.find(ownerId, id);
    if (created === null) throw new Error("the screen that was just created cannot be read");
    return viewOf(created, contextOf(deps, ports, ownerId, id));
  });
}

export function listScreens(deps: DashboardDependencies, token: string, requestId: string): Result<readonly Readonly<{ id: string; name: string; createdAt: string }>[]> {
  return read(deps, token, requestId, (ports, ownerId) => ({ ok: true, value: ports.dashboard.list(ownerId) }));
}

export function getScreen(deps: DashboardDependencies, token: string, screenId: string, requestId: string): Result<ScreenView> {
  return read(deps, token, requestId, (ports, ownerId): Result<ScreenView> => {
    const screen = ports.dashboard.find(ownerId, screenId);
    return screen === null ? notFoundResult() : { ok: true, value: viewOf(screen, contextOf(deps, ports, ownerId, screenId)) };
  });
}

/** Replaces the whole design of a screen; the canonical snapshot comes back, with the states worked out. */
export function saveDesign(deps: DashboardDependencies, token: string, screenId: string, input: DesignInput, requestId: string): Result<ScreenView> {
  return run(deps, token, requestId, (ports, ownerId, nowIso) => {
    if (ports.dashboard.find(ownerId, screenId) === null) throw notFound();
    const context = contextOf(deps, ports, ownerId, screenId);
    const checked = validateDesign(input, context);
    if (!checked.ok) {
      throw new DomainFault({ code: "VALIDATION_FAILED", fields: [...new Set(checked.issues.map((issue) => issue.path))], issues: checked.issues });
    }
    ports.dashboard.replace(ownerId, screenId, checked.value, nowIso);
    ports.audit.append({ ownerId, action: "screen.design_saved", entityId: screenId, at: nowIso, requestId, details: { widgets: checked.value.widgets.length } });
    const saved = ports.dashboard.find(ownerId, screenId);
    if (saved === null) throw new Error("the screen that was just saved cannot be read");
    return viewOf(saved, context);
  });
}

export function listWidgetTypes(deps: DashboardDependencies, token: string, requestId: string): Result<readonly WidgetTypeManifest[]> {
  return read(deps, token, requestId, () => ({ ok: true, value: deps.widgets.describe() }));
}

export type DataColumn = Readonly<{
  /** The key the rows carry this column's values under: the symbol of the column, or `created_at` / `updated_at` / `id`. */
  key: string;
  kind: "column" | "systemColumn";
  displayName: string;
  type: StoredColumn["type"] | "datetime" | "text";
  typeOptions: StoredColumn["typeOptions"];
}>;
export type DataRow = Readonly<{ id: string; values: Readonly<Record<string, CellValue>> }>;
export type WidgetData = Readonly<{
  widgetId: string;
  state: WidgetState;
  /** The registry the widget reads; null when the widget reads nothing. */
  registry: Readonly<{ symbol: string; schemaRevision: number; dataRevision: number }> | null;
  columns: readonly DataColumn[];
  rows: readonly DataRow[];
  total: number;
  page: number;
  pageSize: number;
}>;

const DEFAULT_PAGE_SIZE = 10;
const REGISTER_TABLE = "register-table";

const emptyData = (widget: StoredWidget, state: WidgetState, page: number): WidgetData => {
  const size = widget.config["pageSize"];
  return { widgetId: widget.id, state, registry: null, columns: [], rows: [], total: 0, page, pageSize: typeof size === "number" ? size : DEFAULT_PAGE_SIZE };
};

/**
 * One page of the data of a widget. The registry, the columns, the sort and the page size come from
 * the bindings and the configuration that were saved; the caller names only the widget and the page.
 * A widget that is not `ok` reads nothing: no query is made for a draft, a broken binding or a
 * configuration that waits to be confirmed.
 */
export function readWidgetData(deps: DashboardDependencies, token: string, widgetId: string, page: number, requestId: string): Result<WidgetData> {
  return read(deps, token, requestId, (ports, ownerId): Result<WidgetData> => {
    if (!Number.isInteger(page) || page < 1) return { ok: false, error: { code: "VALIDATION_FAILED", fields: ["page"], issues: [{ path: "page", code: "PAGE_OUT_OF_RANGE" }] } };
    const found = ports.dashboard.findWidget(ownerId, widgetId);
    if (found === null) return notFoundResult();
    const { widget, screenId } = found;
    const state = stateOfStoredWidget(widget, contextOf(deps, ports, ownerId, screenId));
    if (state !== "ok" || widget.type !== REGISTER_TABLE) return { ok: true, value: emptyData(widget, state === "ok" ? "needs_refresh" : state, page) };

    const registryBinding = widget.bindings.find((binding) => binding.slot === "registry");
    const target = registryBinding?.target;
    const registryId = target?.kind === "registry" ? target.registryId : null;
    const known = registryId === null ? null : ports.catalog.registry(ownerId, registryId);
    const registry: StoredRegistry | null = known === null ? null : ports.registries.find(ownerId, known.symbol);
    if (registry === null || registry.id !== registryId) return { ok: true, value: emptyData(widget, "needs_rebinding", page) };

    const columns: DataColumn[] = [];
    const bound = [...widget.bindings].filter((binding) => binding.slot === "columns").sort((a, b) => a.ordinal - b.ordinal);
    for (const binding of bound) {
      if (binding.target.kind === "column") {
        const columnId = binding.target.columnId;
        const column = registry.columns.find((candidate) => candidate.id === columnId);
        if (column === undefined) return { ok: true, value: emptyData(widget, "needs_rebinding", page) };
        columns.push({ key: column.symbol, kind: "column", displayName: column.displayName, type: column.type, typeOptions: column.typeOptions });
      } else if (binding.target.kind === "systemColumn") {
        const symbol = binding.target.symbol;
        columns.push({ key: symbol, kind: "systemColumn", displayName: symbol, type: symbol === "id" ? "text" : "datetime", typeOptions: {} });
      }
    }

    const sortBinding = widget.bindings.find((binding) => binding.slot === "sortColumn");
    let sortSymbol = "created_at";
    if (sortBinding?.target.kind === "systemColumn") sortSymbol = sortBinding.target.symbol;
    else if (sortBinding?.target.kind === "column") {
      const columnId = sortBinding.target.columnId;
      const column = registry.columns.find((candidate) => candidate.id === columnId);
      if (column === undefined) return { ok: true, value: emptyData(widget, "needs_rebinding", page) };
      sortSymbol = column.symbol;
    }
    const sort = resolveSortColumn(registry.columns, sortSymbol);
    const configuredSize = widget.config["pageSize"];
    const pageSize = typeof configuredSize === "number" ? configuredSize : DEFAULT_PAGE_SIZE;
    if (sort === null) return { ok: true, value: emptyData(widget, "needs_rebinding", page) };

    const listed = ports.records.page(registry, { sort, direction: widget.config["sortDirection"] === "asc" ? "asc" : "desc", page, pageSize });
    const rows = listed.records.map((record): DataRow => {
      const values: Record<string, CellValue> = {};
      for (const column of columns) {
        if (column.kind === "column") values[column.key] = record.values[column.key] ?? null;
        else values[column.key] = column.key === "id" ? record.id : column.key === "created_at" ? record.createdAt : record.updatedAt;
      }
      return { id: record.id, values };
    });
    return { ok: true, value: { widgetId: widget.id, state: "ok", registry: { symbol: registry.symbol, schemaRevision: registry.schemaRevision, dataRevision: registry.dataRevision }, columns, rows, total: listed.total, page, pageSize } };
  });
}
