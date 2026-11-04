// Browser widget views. Receives data and callbacks via props; never fetches
// on its own (Architektura §18.3).
export { RegisterTableView } from "./register-table/View.js";
export type { RegisterTableColumn, RegisterTableLabels, RegisterTableValue, RegisterTableViewProps } from "./register-table/View.js";
// The configuration schema of the register table, so the Designer checks a field with the very rule
// the server applies (D34.1); it holds no server code.
export { PAGE_SIZE_RANGE, registerTableConfigSchema } from "./register-table/config.schema.js";
export type { RegisterTableConfig } from "./register-table/config.schema.js";
export { ClockView } from "./clock/View.js";
export type { ClockViewProps } from "./clock/View.js";
export { CLOCK_LABEL_MAX, clockConfigSchema, isKnownTimeZone, OWNER_ZONE } from "./clock/config.schema.js";
export type { ClockConfig } from "./clock/config.schema.js";
