// The catalog of widget types for the rules of a screen (Architektura §13.2, §18.3): the definitions
// of the build (@openlife/widgets/definitions: Zod schemas, no React) behind the port of core/dashboard.
import type { WidgetCatalogPort } from "@openlife/core/dashboard";
import { checkBindingShape, findWidgetDefinition, missingRequiredSlots, normalizeWidgetConfig } from "@openlife/widgets/definitions";

const definitionOf = (type: string) => {
  const definition = findWidgetDefinition(type);
  if (definition === null) throw new TypeError(`no widget type ${type}`);
  return definition;
};

export function createWidgetCatalog(): WidgetCatalogPort {
  return {
    has: (type) => findWidgetDefinition(type) !== null,
    normalizeConfig: (type, input) => normalizeWidgetConfig(definitionOf(type), input),
    bindingProblems: (type, bindings) => checkBindingShape(definitionOf(type), bindings),
    missingRequiredSlots: (type, bindings) => missingRequiredSlots(definitionOf(type), bindings),
    minSize: (type) => definitionOf(type).minSize,
  };
}
