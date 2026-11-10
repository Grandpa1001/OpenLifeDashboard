// The effective application options at run time (Architektura §14.1; D41.3): the catalog with the
// stored values and the environment overrides, read from the database once at the start and again
// after each change or reset. The consumers (the limits of a record, the rotation of the log) call
// `current()` at each use, so a change takes effect with the next one. `current()` never reads the
// database: it is called inside units of work (a rule reading its limit) and in the log, where a
// nested read must not happen. A read that fails, or finds a value the catalog does not accept,
// keeps the last good set: the log and the rules must not stop on it.
import type { EffectiveSetting, SettingDefinition, SettingOverrides } from "@openlife/core/settings";
import { resolveSettings } from "@openlife/core/settings";

export type EffectiveSettings = Readonly<{
  /** The effective options now. */
  current: () => readonly EffectiveSetting[];
  /** Reads the stored values again; called after a change or a reset, outside any unit of work. */
  refresh: () => void;
  /** An integer option now; a programming error when the catalog has no such option. */
  integer: (key: string) => number;
}>;

export function createEffectiveSettings(options: Readonly<{ catalog: readonly SettingDefinition[]; environment: SettingOverrides["environment"]; readStored: () => Readonly<Record<string, unknown>>; initial: readonly EffectiveSetting[]; onInvalid: (fields: readonly string[]) => void }>): EffectiveSettings {
  let settings = options.initial;
  const load = (): void => {
    let stored: Readonly<Record<string, unknown>>;
    try {
      stored = options.readStored();
    } catch {
      options.onInvalid([]);
      return;
    }
    const resolution = resolveSettings(options.catalog, { database: stored, environment: options.environment });
    if (resolution.ok) settings = resolution.settings;
    else options.onInvalid(resolution.fields);
  };
  load();
  const current = (): readonly EffectiveSetting[] => settings;
  return {
    current,
    refresh: load,
    integer: (key) => {
      const value = current().find((setting) => setting.key === key)?.value;
      if (typeof value !== "number") throw new Error(`the option ${key} is not an integer option of the catalog`);
      return value;
    },
  };
}
