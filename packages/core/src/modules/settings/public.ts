// Public API of the settings module (Architektura §13.2, §18.6, §18.7).
export { acceptsSettingValue, integerSetting, RECORD_BODY_OVERHEAD_KIB, resolveSettings } from "./domain/resolve-settings.js";
export type {
  EffectiveSetting,
  SettingDefinition,
  SettingOverrides,
  SettingSource,
  SettingsResolution,
  SettingValue,
} from "./domain/types.js";
export { patchAppSettings, readAppSettings, resetAppSetting } from "./application/app-settings.js";
export type { AppSettingsDependencies, AppSettingsPorts } from "./application/app-settings.js";
export { readOwnerPreferences, readSetupStatus, saveOwnerPreferences } from "./application/setup.js";
export type { DataChoice, PreferencesView, SetupDependencies, SetupStage, SetupStatus } from "./application/setup.js";
export type { AppSettingStore, OwnerPreferences, OwnerPreferencesStore, SetupPorts } from "./ports.js";
