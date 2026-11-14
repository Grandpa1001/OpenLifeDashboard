// From a template to a design (Architektura Załącznik G; D47.2): every widget gets a new identifier, and every
// path `Field.*` is resolved by symbol against the catalog of this installation. A path that names nothing here is
// not an error: the binding keeps the path as it was written and a target with identifiers the catalog does not
// know, so the widget is `needs_rebinding` and the Designer shows the path that is missing. A widget of a type this
// build lacks is kept as it came and waits for a refresh. Whatever else is wrong with the file is refused with the
// path of the defect and a stable code, as a design is.
import { type CheckedDesign, type CheckedWidget, type DesignIssue, type DesignResult, type FieldRef, type SlotBinding, type WidgetInput } from "./design.js";
import { inspectWidget, isValidScreenName, lookupOf, TOLERANT, type DesignContext } from "./design-rules.js";
import type { ScreenTemplateDesign } from "./screen-template.js";

const SYSTEM_COLUMNS = ["created_at", "updated_at", "id"] as const;
const SYSTEM_VALUES = ["dzis", "wczoraj", "teraz", "strefa", "jezyk", "wersja"] as const;
const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/** The target a path names in this installation, or one with new identifiers when nothing is named; null when the path is not a path of a field. */
function resolvePath(path: string, context: DesignContext, mint: (key: string) => string): FieldRef | null {
  const parts = path.split(".");
  if (parts[0] !== "Field" || parts.some((part) => part === "")) return null;
  const [, area, first, second] = parts;
  if (area === "System" && parts.length === 3) return first !== undefined && isOneOf(SYSTEM_VALUES, first) ? { kind: "system", symbol: first } : null;
  if (area === "Config" && parts.length === 3 && first !== undefined) {
    const entry = context.catalog.configEntryBySymbol(context.ownerId, first);
    return { kind: "config", entryId: entry?.id ?? mint(`config:${first}`) };
  }
  if (area === "Register" && (parts.length === 3 || parts.length === 4) && first !== undefined) {
    const registry = context.catalog.registryBySymbol(context.ownerId, first);
    const registryId = registry?.id ?? mint(`registry:${first}`);
    if (second === undefined) return { kind: "registry", registryId };
    if (isOneOf(SYSTEM_COLUMNS, second)) return { kind: "systemColumn", registryId, symbol: second };
    const column = registry?.columns.find((candidate) => candidate.symbol === second && !candidate.deleted);
    return { kind: "column", registryId, columnId: column?.id ?? mint(`column:${first}.${second}`) };
  }
  return null;
}

/** The design a template makes on this installation, with new identifiers, or the defects of the file. */
export function designFromTemplate(template: ScreenTemplateDesign, context: DesignContext, newId: () => string): DesignResult {
  const issues: DesignIssue[] = [];
  const { policy } = context;
  if (!isValidScreenName(template.name, policy)) issues.push({ path: "name", code: "NAME_INVALID" });
  if (!policy.themes.includes(template.theme)) issues.push({ path: "theme", code: "THEME_UNKNOWN" });
  if (!policy.accents.includes(template.accent)) issues.push({ path: "accent", code: "ACCENT_UNKNOWN" });
  if (template.widgets.length > policy.maxWidgets) issues.push({ path: "widgets", code: "LIMIT_WIDGETS" });

  const lookup = lookupOf(context);
  // One identifier for everything the catalog does not know under the same name, so two bindings to the same missing registry still agree.
  const minted = new Map<string, string>();
  const mint = (key: string): string => {
    let id = minted.get(key);
    if (id === undefined) {
      id = newId();
      minted.set(key, id);
    }
    return id;
  };

  const widgets: CheckedWidget[] = [];
  template.widgets.slice(0, policy.maxWidgets).forEach((source, index) => {
    const base = `widgets.${index}`;
    const bindings: SlotBinding[] = [];
    source.bindings.forEach((binding, at) => {
      const target = resolvePath(binding.path, context, mint);
      if (target === null) issues.push({ path: `${base}.bindings.${at}.path`, code: "PATH_INVALID" });
      else bindings.push({ slot: binding.slot, ordinal: binding.ordinal, path: binding.path, target });
    });
    const widget: WidgetInput = { id: newId(), type: source.type, config: source.config, layout: source.layout, bindings };
    const inspected = inspectWidget(widget, base, context, lookup, TOLERANT);
    issues.push(...inspected.issues);
    widgets.push({ ...widget, config: inspected.config, state: inspected.state });
  });

  if (issues.length > 0) return { ok: false, issues };
  const value: CheckedDesign = { name: template.name.trim(), theme: template.theme, accent: template.accent, widgets };
  return { ok: true, value };
}

