// Public API of the dashboard adapter (Architektura §13.3): the store of screens and the reader of
// the catalog the rules of a design ask.
export { bindDashboardStore } from "./dashboard-store.js";
export { bindCatalogReader, bindConfigBindingCounts, bindDependentWidgets } from "./catalog-reader.js";
export { bindDashboardSystemTables } from "./system-tables.js";
