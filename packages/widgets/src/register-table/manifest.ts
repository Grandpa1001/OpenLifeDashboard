import type { WidgetDefinition } from "../definition.js";
import { registerTableConfigSchema, type RegisterTableConfig } from "./config.schema.js";
import { migrateRegisterTableConfig } from "./migrate-config.js";
import { REGISTER_TABLE_CONFIG_VERSION } from "./version.js";

/** The register table (Scope §6.2): a registry, the columns to show and the column it is sorted by. */
export const registerTableDefinition: WidgetDefinition<RegisterTableConfig> = {
  type: "register-table",
  configVersion: REGISTER_TABLE_CONFIG_VERSION,
  slots: [
    { name: "registry", cardinality: "one", required: true, accepts: ["registry"] },
    { name: "columns", cardinality: "many", required: true, accepts: ["column", "systemColumn"] },
    // Unbound, the table is sorted by the creation time of its registry.
    { name: "sortColumn", cardinality: "one", required: false, accepts: ["column", "systemColumn"] },
  ],
  configSchema: registerTableConfigSchema,
  migrateConfig: migrateRegisterTableConfig,
  capabilities: ["records:add"],
  defaultSize: { w: 8, h: 8 },
  minSize: { w: 3, h: 4 },
};
