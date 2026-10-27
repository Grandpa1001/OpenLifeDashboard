// Ports of the dashboard module (Architektura §13.2, §18.3). The catalog of widget types is built
// from the definitions of the build; the reader looks into the registries of the owner. Neither
// returns more than the rules need.
import type { SlotBinding } from "./domain/design.js";

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
