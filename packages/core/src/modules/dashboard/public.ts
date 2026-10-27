// Public API of core/dashboard (Architektura §13.3): the design of a screen, its rules and ports.
export { stateOfStoredWidget, validateDesign } from "./domain/design-rules.js";
export type { DesignContext } from "./domain/design-rules.js";
export { LAYOUT_NAMES } from "./domain/design.js";
export type {
  CheckedDesign,
  CheckedWidget,
  DesignInput,
  DesignIssue,
  DesignIssueCode,
  DesignPolicy,
  DesignResult,
  FieldRef,
  Layout,
  LayoutName,
  LayoutRect,
  SlotBinding,
  WidgetInput,
  WidgetState,
} from "./domain/design.js";
export type { BindingShapeProblem, CatalogRegistry, ConfigOutcome, DashboardCatalogReader, WidgetCatalogPort } from "./ports.js";
