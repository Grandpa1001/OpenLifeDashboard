import type { WidgetDefinition } from "../definition.js";
import { clockConfigSchema, type ClockConfig } from "./config.schema.js";
import { migrateClockConfig } from "./migrate-config.js";
import { CLOCK_CONFIG_VERSION } from "./version.js";

/** The clock (Scope §6.3): the time of a zone, set only in the widget; it binds nothing and reads nothing of the server. */
export const clockDefinition: WidgetDefinition<ClockConfig> = {
  type: "clock",
  configVersion: CLOCK_CONFIG_VERSION,
  slots: [],
  configSchema: clockConfigSchema,
  migrateConfig: migrateClockConfig,
  capabilities: [],
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
};
