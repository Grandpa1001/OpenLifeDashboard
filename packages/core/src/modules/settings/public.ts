// Public API of the settings module (Architektura §13.2, §18.6, §18.7).
export { RECORD_BODY_OVERHEAD_KIB, resolveSettings } from "./domain/resolve-settings.js";
export type {
  EffectiveSetting,
  SettingDefinition,
  SettingOverrides,
  SettingSource,
  SettingsResolution,
} from "./domain/types.js";
export { readOwnerPreferences, readSetupStatus, saveOwnerPreferences } from "./application/setup.js";
export type { DataChoice, PreferencesView, SetupDependencies, SetupStage, SetupStatus } from "./application/setup.js";
export type { OwnerPreferences, OwnerPreferencesStore, SetupPorts } from "./ports.js";
