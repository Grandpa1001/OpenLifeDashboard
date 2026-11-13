// The limits of the domain modules from the effective options (Architektura §14.3; D41.3). Each limit
// reads the option at the moment it is used, so a change applies to the next write and nothing stored
// is trimmed by it. The objects have the shape the modules ask for; their properties are getters.
import type { ConfigLimits } from "@openlife/core/configuration";
import type { DictionaryLimits } from "@openlife/core/dictionaries";
import type { RegistryLimits } from "@openlife/core/registries";
import type { EffectiveSettings } from "./effective-settings.js";

const KIB = 1024;
const MIB = 1024 * KIB;
/** The longest description of an entry of ConfigTable: not an option, a rule of the entry. */
const CONFIG_DESCRIPTION_MAX = 500;

export type LiveLimits = Readonly<{
  registry: RegistryLimits;
  dictionary: DictionaryLimits;
  config: ConfigLimits;
  /** The largest record, in bytes of its values as JSON (`limits.recordMaxKiB`). */
  recordMaxBytes: () => number;
  /** The largest file an import takes, in bytes (`limits.importMaxMiB`). */
  importMaxBytes: () => number;
}>;

export function liveLimits(settings: EffectiveSettings): LiveLimits {
  return {
    registry: {
      get maxRegistries() {
        return settings.integer("limits.registries");
      },
      get maxColumns() {
        return settings.integer("limits.columnsPerRegistry");
      },
      get textMaxChars() {
        return settings.integer("limits.textLength");
      },
    },
    dictionary: {
      get maxDictionaries() {
        return settings.integer("limits.dictionaries");
      },
      get maxValues() {
        return settings.integer("limits.dictionaryValues");
      },
    },
    config: {
      get maxEntries() {
        return settings.integer("limits.configEntries");
      },
      get valueMaxCodePoints() {
        return settings.integer("limits.textLength");
      },
      descriptionMaxCodePoints: CONFIG_DESCRIPTION_MAX,
    },
    recordMaxBytes: () => settings.integer("limits.recordMaxKiB") * KIB,
    importMaxBytes: () => settings.integer("limits.importMaxMiB") * MIB,
  };
}
