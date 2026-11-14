// The rules of a design that need no database (Architektura §5.5, §5.6, §8.1, §18.3, §18.5): the
// snapshot of a screen is checked whole before anything is written, and the state of each widget is
// worked out from its configuration, its bindings and the catalog as it is now. The same checks give
// the state of a stored widget when a screen is read, so a column deleted since the save turns the
// widget to `needs_rebinding` without anyone writing it.
import { utf8Length } from "../../../foundation/public.js";
import type { CatalogRegistry, DashboardCatalogReader, WidgetCatalogPort } from "../ports.js";
import {
  LAYOUT_NAMES,
  type CheckedDesign,
  type CheckedWidget,
  type DesignInput,
  type DesignIssue,
  type DesignIssueCode,
  type DesignPolicy,
  type DesignResult,
  type FieldRef,
  type SlotBinding,
  type WidgetInput,
  type WidgetState,
} from "./design.js";

export type DesignContext = Readonly<{
  ownerId: string;
  /** The screen the design is for: a widget identifier that lives on another screen is not taken over. */
  screenId: string;
  policy: DesignPolicy;
  widgets: WidgetCatalogPort;
  catalog: DashboardCatalogReader;
  /** The widgets of the screen as they are stored, by identifier: one that comes back unchanged is not judged again (D47.2). */
  stored?: ReadonlyMap<string, WidgetInput>;
}>;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex -- a control character in a name is exactly what is refused.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

const REGISTER_PATH = "Field.Register";
const SYSTEM_PATH = "Field.System";
const CONFIG_PATH = "Field.Config";

/** The registry a target belongs to, if it is of a registry. */
const registryOf = (target: FieldRef): string | null => (target.kind === "registry" || target.kind === "column" || target.kind === "systemColumn" ? target.registryId : null);

type Looked = { registry: CatalogRegistry | null };
export type Inspection = Readonly<{ issues: readonly DesignIssue[]; state: WidgetState; config: Readonly<Record<string, unknown>> }>;

/** The path a target must carry, or null when the catalog does not know the target at all. */
function expectedPath(target: FieldRef, registry: CatalogRegistry | null, entry: Readonly<{ symbol: string }> | null): string | null {
  switch (target.kind) {
    case "registry":
      return registry === null ? null : `${REGISTER_PATH}.${registry.symbol}`;
    case "systemColumn":
      return registry === null ? null : `${REGISTER_PATH}.${registry.symbol}.${target.symbol}`;
    case "column": {
      const column = registry?.columns.find((candidate) => candidate.id === target.columnId);
      return registry === null || column === undefined ? null : `${REGISTER_PATH}.${registry.symbol}.${column.symbol}`;
    }
    case "system":
      return `${SYSTEM_PATH}.${target.symbol}`;
    case "config":
      return entry === null ? null : `${CONFIG_PATH}.${entry.symbol}`;
  }
}

/** Whether a target that exists is broken now: its registry or its column is deleted. */
function isBroken(target: FieldRef, registry: CatalogRegistry | null): boolean {
  if (registry === null) return false;
  if (registry.deleted) return true;
  return target.kind === "column" && registry.columns.find((column) => column.id === target.columnId)?.deleted === true;
}

/** A screen name is text of 1 to `nameMaxChars` characters after trimming, without control characters. */
export function isValidScreenName(name: string, policy: Pick<DesignPolicy, "nameMaxChars">): boolean {
  const trimmed = name.trim();
  return trimmed !== "" && Array.from(trimmed).length <= policy.nameMaxChars && !CONTROL_CHARACTERS.test(name);
}

/**
 * How strictly a widget is judged. A widget being saved for the first time is judged in full. One that is stored,
 * one that comes back from the Designer unchanged and one that comes from a template are tolerated where the world
 * may have moved on or the file comes from another installation: a target the catalog does not know is a broken
 * binding (an entry of ConfigTable is deleted outright and leaves no row), not a defect, and a type this build lacks
 * is kept as it came and waits for a refresh (Architektura AR13).
 */
export type InspectMode = Readonly<{ tolerant: boolean }>;
export const STRICT: InspectMode = { tolerant: false };
export const TOLERANT: InspectMode = { tolerant: true };

/** The widget as inspected: its configuration in the current version, its issues and the state it gets. */
export function inspectWidget(widget: WidgetInput, base: string, context: DesignContext, lookup: (registryId: string) => CatalogRegistry | null, mode: InspectMode): Inspection {
  const issues: DesignIssue[] = [];
  const add = (path: string, code: DesignIssueCode): void => void issues.push({ path: `${base}.${path}`, code });
  const { policy } = context;

  if (!context.widgets.has(widget.type)) {
    if (!mode.tolerant) add("type", "WIDGET_TYPE_UNKNOWN");
    else {
      // Kept as it came: only the size is bounded, and nothing of it is read or run.
      if (utf8Length(JSON.stringify(widget.config)) > context.policy.maxWidgetJsonBytes) add("config", "CONFIG_TOO_LARGE");
      if (widget.bindings.length > context.policy.maxBindingsPerWidget) add("bindings", "LIMIT_BINDINGS");
      if (utf8Length(JSON.stringify(widget.bindings)) > context.policy.maxWidgetJsonBytes) add("bindings", "BINDINGS_TOO_LARGE");
    }
    return { issues, state: "needs_refresh", config: widget.config };
  }

  // The configuration: the current version with its defaults, sent back to the owner when it is of a version this build does not write.
  let state: WidgetState = "ok";
  let config: Readonly<Record<string, unknown>> = widget.config;
  if (utf8Length(JSON.stringify(widget.config)) > policy.maxWidgetJsonBytes) add("config", "CONFIG_TOO_LARGE");
  const normalized = context.widgets.normalizeConfig(widget.type, widget.config);
  if (normalized.ok) config = normalized.config;
  else if (normalized.code === "INVALID_CONFIG") add("config", "CONFIG_INVALID");
  else state = "needs_refresh";

  // The bindings: how many, how they sit in their slots, and where they point.
  if (widget.bindings.length > policy.maxBindingsPerWidget) add("bindings", "LIMIT_BINDINGS");
  if (utf8Length(JSON.stringify(widget.bindings)) > policy.maxWidgetJsonBytes) add("bindings", "BINDINGS_TOO_LARGE");
  for (const problem of context.widgets.bindingProblems(widget.type, widget.bindings)) add("bindings", problem.code);

  let broken = false;
  const registries = new Set<string>();
  widget.bindings.forEach((binding, index) => {
    const here = `bindings.${index}`;
    const registryId = registryOf(binding.target);
    if (registryId !== null) registries.add(registryId);
    const entry = binding.target.kind === "config" ? context.catalog.configEntry(context.ownerId, binding.target.entryId) : null;
    const unknown = (): void => {
      if (mode.tolerant) broken = true;
      else add(`${here}.target`, "TARGET_UNKNOWN");
    };
    if (binding.target.kind === "config" && entry === null) return unknown();
    const registry = registryId === null ? null : lookup(registryId);
    if (registryId !== null && registry === null) return unknown();
    const expected = expectedPath(binding.target, registry, entry);
    if (expected === null) return unknown();
    if (binding.path !== expected) add(`${here}.path`, "PATH_MISMATCH");
    if (isBroken(binding.target, registry)) broken = true;
  });
  if (registries.size > 1) add("bindings", "REGISTRY_MISMATCH");

  // The size and place in each layout.
  const minimum = context.widgets.minSize(widget.type);
  for (const name of LAYOUT_NAMES) {
    const rect = widget.layout[name];
    const columns = policy.gridColumns[name];
    if (rect.x + rect.w > columns) add(`layout.${name}`, "LAYOUT_OUT_OF_GRID");
    else if (rect.w < Math.min(minimum.w, columns) || rect.h < minimum.h) add(`layout.${name}`, "LAYOUT_TOO_SMALL");
  }

  if (state !== "needs_refresh") {
    if (broken) state = "needs_rebinding";
    else if (context.widgets.missingRequiredSlots(widget.type, widget.bindings).length > 0) state = "draft";
  }
  return { issues, state, config };
}

export function lookupOf(context: DesignContext): (registryId: string) => CatalogRegistry | null {
  const seen = new Map<string, Looked>();
  return (registryId) => {
    let looked = seen.get(registryId);
    if (looked === undefined) {
      looked = { registry: context.catalog.registry(context.ownerId, registryId) };
      seen.set(registryId, looked);
    }
    return looked.registry;
  };
}

/** A widget that comes back as it is stored (the same type, configuration and bindings; its place may differ) needs no new judgement. */
function isUnchanged(widget: WidgetInput, context: DesignContext): boolean {
  const before = context.stored?.get(widget.id);
  return before !== undefined && before.type === widget.type && JSON.stringify(before.config) === JSON.stringify(widget.config) && JSON.stringify(before.bindings) === JSON.stringify(widget.bindings);
}

/**
 * The whole design of a screen, before anything is written. Every defect is returned with the path
 * of its field in the snapshot; a design with any is refused as it stands. A target that exists but
 * is broken (its column or registry deleted) is no defect: the widget is `needs_rebinding`, and the
 * rest of the screen can still be saved.
 */
export function validateDesign(input: DesignInput, context: DesignContext): DesignResult {
  const issues: DesignIssue[] = [];
  const { policy } = context;
  if (!isValidScreenName(input.name, policy)) issues.push({ path: "name", code: "NAME_INVALID" });
  if (!policy.themes.includes(input.theme)) issues.push({ path: "theme", code: "THEME_UNKNOWN" });
  if (!policy.accents.includes(input.accent)) issues.push({ path: "accent", code: "ACCENT_UNKNOWN" });
  if (input.widgets.length > policy.maxWidgets) issues.push({ path: "widgets", code: "LIMIT_WIDGETS" });

  const lookup = lookupOf(context);
  const seen = new Set<string>();
  const widgets: CheckedWidget[] = [];
  input.widgets.slice(0, policy.maxWidgets).forEach((widget, index) => {
    const base = `widgets.${index}`;
    if (!ID.test(widget.id)) issues.push({ path: `${base}.id`, code: "WIDGET_ID_INVALID" });
    else if (seen.has(widget.id)) issues.push({ path: `${base}.id`, code: "WIDGET_ID_DUPLICATE" });
    else {
      const holder = context.catalog.screenOfWidget(widget.id);
      if (holder !== null && holder !== context.screenId) issues.push({ path: `${base}.id`, code: "WIDGET_ID_TAKEN" });
    }
    seen.add(widget.id);
    const inspected = inspectWidget(widget, base, context, lookup, isUnchanged(widget, context) ? TOLERANT : STRICT);
    issues.push(...inspected.issues);
    widgets.push({ id: widget.id, type: widget.type, config: inspected.config, layout: widget.layout, bindings: widget.bindings, state: inspected.state });
  });

  if (issues.length > 0) return { ok: false, issues };
  const value: CheckedDesign = { name: input.name.trim(), theme: input.theme, accent: input.accent, widgets };
  return { ok: true, value };
}

/**
 * The state of a widget that is already stored, in the catalog as it is now. A defect that the save
 * would have refused (a type this build lacks, a configuration or binding that no longer fits) is
 * `needs_refresh`: the owner confirms the widget again, and nothing is read for it.
 */
export function stateOfStoredWidget(widget: WidgetInput, context: DesignContext): WidgetState {
  const inspected = inspectWidget(widget, "widget", context, lookupOf(context), TOLERANT);
  return inspected.issues.length > 0 ? "needs_refresh" : inspected.state;
}

export type { SlotBinding };
