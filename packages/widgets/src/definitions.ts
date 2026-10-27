// Runtime-neutral widget definitions (manifests, config schemas, migrations).
// Must stay free of React and Node so the server can import it (AR14).
export type { SlotBinding, SlotDefinition, SlotKind, WidgetDefinition } from "./definition.js";
export { checkBindingShape, findWidgetDefinition, missingRequiredSlots, normalizeWidgetConfig, WIDGET_DEFINITIONS } from "./catalog.js";
export type { BindingShapeIssue, BindingShapeProblem, ConfigOutcome } from "./catalog.js";
export { PAGE_SIZE_RANGE, registerTableConfigSchema } from "./register-table/config.schema.js";
export type { RegisterTableConfig } from "./register-table/config.schema.js";
export { registerTableDefinition } from "./register-table/manifest.js";
