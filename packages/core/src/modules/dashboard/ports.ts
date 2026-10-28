// Ports of the dashboard module (Architektura §13.2, §18.3). The catalog of widget types is built
// from the definitions of the build; the reader looks into the registries of the owner. Neither
// returns more than the rules need.
import type { CheckedDesign, SlotBinding, WidgetInput, WidgetState } from "./domain/design.js";

export type ConfigOutcome =
  | Readonly<{ ok: true; config: Readonly<Record<string, unknown>> & { readonly v: number } }>
  | Readonly<{ ok: false; code: "INVALID_CONFIG" | "NEEDS_REFRESH" }>;

export type BindingShapeProblem = Readonly<{ slot: string; code: "SLOT_UNKNOWN" | "SLOT_TOO_MANY" | "TARGET_KIND_NOT_ACCEPTED" | "ORDINAL_DUPLICATE" | "ORDINAL_GAP" }>;

export interface WidgetCatalogPort {
  has(type: string): boolean;
  /** The configuration of a widget in the current version of its type, or why it is not one. */
  normalizeConfig(type: string, input: unknown): ConfigOutcome;
  /** The shape of the bindings against the slots of the type; says nothing of whether the targets exist. */
  bindingProblems(type: string, bindings: readonly Pick<SlotBinding, "slot" | "ordinal" | "target">[]): readonly BindingShapeProblem[];
  /** The required slots with no binding: a widget with any is a draft. */
  missingRequiredSlots(type: string, bindings: readonly Pick<SlotBinding, "slot" | "ordinal" | "target">[]): readonly string[];
  /** The least size the type may be given, before it is limited to the columns of a layout. */
  minSize(type: string): Readonly<{ w: number; h: number }>;
}

/** A registry of the owner as the catalog holds it, deleted columns and a deleted registry included: a binding to them is broken, not unknown. */
export type CatalogRegistry = Readonly<{
  id: string;
  symbol: string;
  deleted: boolean;
  columns: readonly Readonly<{ id: string; symbol: string; deleted: boolean }>[];
}>;

export interface DashboardCatalogReader {
  /** The registry with this identifier if it is the owner's, or null (also for another owner's). */
  registry(ownerId: string, registryId: string): CatalogRegistry | null;
  /** The screen that holds a widget with this identifier, of any owner, or null. */
  screenOfWidget(widgetId: string): string | null;
}

/** A widget as it is stored: what was designed, and the state it had when it was written (a read works the state out again). */
export type StoredWidget = WidgetInput & Readonly<{ state: WidgetState }>;

export type StoredScreen = Readonly<{
  id: string;
  ownerId: string;
  name: string;
  theme: string;
  accent: string;
  createdAt: string;
  updatedAt: string;
  /** In the order of the snapshot. */
  widgets: readonly StoredWidget[];
}>;

export type NewScreen = Readonly<{ id: string; ownerId: string; name: string; theme: string; accent: string; /** UTC, ISO 8601. */ nowIso: string }>;

/**
 * The screens of the owner. A screen is replaced as one aggregate in the unit of work of the use
 * case: the widgets that are not in the new design are gone with their bindings, the others are
 * written under the same identifiers, and a widget identifier that lives on another screen is never
 * taken over, whatever the rules before it have decided.
 */
export interface DashboardStore {
  /** Screens of the owner. */
  count(ownerId: string): number;
  create(screen: NewScreen): void;
  find(ownerId: string, screenId: string): StoredScreen | null;
  /** The widget with this identifier if its screen is the owner's, with the screen it is on. */
  findWidget(ownerId: string, widgetId: string): Readonly<{ screenId: string; widget: StoredWidget }> | null;
  replace(ownerId: string, screenId: string, design: CheckedDesign, nowIso: string): void;
}
