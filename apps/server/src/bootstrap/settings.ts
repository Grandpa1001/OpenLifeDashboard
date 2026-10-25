import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { resolveSettings, type SettingsResolution } from "@openlife/core/settings";
import type { EnvironmentOverrides } from "./environment.js";

/**
 * Effective options for bootstrap: the public catalog with stored and environment overrides.
 * Until the settings adapter reads the database (D04/D41) callers pass an empty database map;
 * tests pass synthetic ones (Architektura §14.5).
 */
export function resolveBootstrapSettings(
  environment: EnvironmentOverrides,
  database: Readonly<Record<string, unknown>> = {},
): SettingsResolution {
  return resolveSettings(SETTINGS_CATALOG, { database, environment });
}
