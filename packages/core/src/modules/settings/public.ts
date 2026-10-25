// Public API of the settings module (Architektura §13.2, §18.6).
export { RECORD_BODY_OVERHEAD_KIB, resolveSettings } from "./domain/resolve-settings.js";
export type {
  EffectiveSetting,
  SettingDefinition,
  SettingOverrides,
  SettingSource,
  SettingsResolution,
} from "./domain/types.js";
