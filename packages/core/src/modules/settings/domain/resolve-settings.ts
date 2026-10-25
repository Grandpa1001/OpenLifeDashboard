import type { EffectiveSetting, SettingDefinition, SettingOverrides, SettingSource, SettingsResolution } from "./types.js";

/** A record limit must leave room for the JSON envelope inside one request body. */
export const RECORD_BODY_OVERHEAD_KIB = 8;
const RECORD_LIMIT_KEY = "limits.recordMaxKiB";
const BODY_LIMIT_KEY = "limits.jsonBodyKiB";

/**
 * Effective option values with precedence default < database < explicit environment
 * (Architektura §14.1). Every override is validated, including ones that are shadowed, and any
 * problem rejects the whole set: the result is either complete or only error fields. Error
 * fields name the input the owner must fix: the environment variable for env values, the
 * setting key otherwise. Pure: no environment, file system or database access.
 */
export function resolveSettings(catalog: readonly SettingDefinition[], overrides: SettingOverrides): SettingsResolution {
  const invalid = new Set<string>();
  const byKey = new Map(catalog.map((definition) => [definition.key, definition]));

  for (const [source, values] of [["db", overrides.database], ["env", overrides.environment]] as const) {
    for (const key of Object.keys(values)) {
      const definition = byKey.get(key);
      if (!definition || (source === "env" && !definition.envOverride)) {
        invalid.add(key);
      }
    }
  }

  const fieldOf = (definition: SettingDefinition, source: SettingSource): string =>
    source === "env" && definition.envOverride ? definition.envOverride : definition.key;
  const accepts = (definition: SettingDefinition, value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= definition.min && value <= definition.max;

  const settings: EffectiveSetting[] = [];
  const fieldByKey = new Map<string, string>();
  for (const definition of catalog) {
    let value = definition.defaultValue;
    let source: SettingSource = "default";
    for (const [candidateSource, values] of [["db", overrides.database], ["env", overrides.environment]] as const) {
      if (!Object.hasOwn(values, definition.key)) {
        continue;
      }
      const candidate = values[definition.key];
      if (!accepts(definition, candidate)) {
        invalid.add(fieldOf(definition, candidateSource));
        continue;
      }
      value = candidate;
      source = candidateSource;
    }
    const lockedByEnv = source === "env";
    settings.push({
      key: definition.key,
      value,
      source,
      editable: definition.editable && !lockedByEnv,
      restartRequired: definition.apply === "restart" || lockedByEnv,
    });
    fieldByKey.set(definition.key, fieldOf(definition, source));
  }

  const record = settings.find((setting) => setting.key === RECORD_LIMIT_KEY);
  const body = settings.find((setting) => setting.key === BODY_LIMIT_KEY);
  if (record && body && record.value + RECORD_BODY_OVERHEAD_KIB > body.value) {
    invalid.add(fieldByKey.get(RECORD_LIMIT_KEY) ?? RECORD_LIMIT_KEY).add(fieldByKey.get(BODY_LIMIT_KEY) ?? BODY_LIMIT_KEY);
  }

  return invalid.size > 0 ? { ok: false, code: "CONFIG_INVALID", fields: [...invalid].sort() } : { ok: true, settings };
}
