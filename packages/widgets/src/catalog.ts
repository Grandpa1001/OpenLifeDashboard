// The types of widgets of this build (Architektura §8.2): a list made at compile time, so a new type
// is a new folder and a release, and nothing is loaded at run time. The server's catalog port and
// the rules of a screen are built on these functions.
import type { SlotBinding, SlotKind, WidgetDefinition } from "./definition.js";
import { registerTableDefinition } from "./register-table/manifest.js";

export const WIDGET_DEFINITIONS: readonly WidgetDefinition<never>[] = [registerTableDefinition as WidgetDefinition<never>];

export function findWidgetDefinition(type: string): WidgetDefinition<never> | null {
  return WIDGET_DEFINITIONS.find((definition) => definition.type === type) ?? null;
}

export type ConfigOutcome = Readonly<{ ok: true; config: Readonly<Record<string, unknown>> & { readonly v: number } }> | Readonly<{ ok: false; code: "INVALID_CONFIG" | "NEEDS_REFRESH" }>;

/** The configuration of a widget in its current version, with the defaults of its schema, or why not. */
export function normalizeWidgetConfig(definition: WidgetDefinition<never>, input: unknown): ConfigOutcome {
  const migrated = definition.migrateConfig(input);
  if (migrated === "needs_refresh") return { ok: false, code: "NEEDS_REFRESH" };
  const parsed = definition.configSchema.safeParse(migrated);
  return parsed.success ? { ok: true, config: parsed.data as Readonly<Record<string, unknown>> & { readonly v: number } } : { ok: false, code: "INVALID_CONFIG" };
}

export type BindingShapeIssue = "SLOT_UNKNOWN" | "SLOT_TOO_MANY" | "TARGET_KIND_NOT_ACCEPTED" | "ORDINAL_DUPLICATE" | "ORDINAL_GAP";
export type BindingShapeProblem = Readonly<{ slot: string; code: BindingShapeIssue }>;

/** What a binding looks like to its slot, without a catalog: the slot exists, its cardinality holds, the kind of target is accepted and the ordinals are 0, 1, 2… */
export function checkBindingShape(definition: WidgetDefinition<never>, bindings: readonly SlotBinding[]): readonly BindingShapeProblem[] {
  const problems: BindingShapeProblem[] = [];
  const bySlot = new Map<string, SlotBinding[]>();
  for (const binding of bindings) bySlot.set(binding.slot, [...(bySlot.get(binding.slot) ?? []), binding]);
  for (const [name, list] of bySlot) {
    const slot = definition.slots.find((candidate) => candidate.name === name);
    if (slot === undefined) {
      problems.push({ slot: name, code: "SLOT_UNKNOWN" });
      continue;
    }
    if (slot.cardinality === "one" && list.length > 1) problems.push({ slot: name, code: "SLOT_TOO_MANY" });
    if (list.some((binding) => !(slot.accepts as readonly SlotKind[]).includes(binding.target.kind))) problems.push({ slot: name, code: "TARGET_KIND_NOT_ACCEPTED" });
    const ordinals = list.map((binding) => binding.ordinal).sort((a, b) => a - b);
    if (new Set(ordinals).size !== ordinals.length) problems.push({ slot: name, code: "ORDINAL_DUPLICATE" });
    else if (ordinals.some((ordinal, index) => ordinal !== index)) problems.push({ slot: name, code: "ORDINAL_GAP" });
  }
  return problems;
}

/** The required slots that have no binding: a widget with any is a draft. */
export function missingRequiredSlots(definition: WidgetDefinition<never>, bindings: readonly SlotBinding[]): readonly string[] {
  return definition.slots.filter((slot) => slot.required && !bindings.some((binding) => binding.slot === slot.name)).map((slot) => slot.name);
}
