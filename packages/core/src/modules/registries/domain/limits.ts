// Limits of the registry catalog (Architektura §4.3) as the values the rules use when nothing else
// is passed. The option catalog (D41) makes them configurable; the rules take them as a dependency
// (`RegistryLimits`) and never read the environment or the settings themselves.
export type RegistryLimits = Readonly<{
  /** Registries that are not deleted. */
  maxRegistries: number;
  maxColumns: number;
  /** Characters of a text value (and of a text default). */
  textMaxChars: number;
}>;

export const DEFAULT_REGISTRY_LIMITS: RegistryLimits = { maxRegistries: 200, maxColumns: 60, textMaxChars: 10_000 };

/** Longest display name of a registry or a column, in characters, after trimming. */
export const DISPLAY_NAME_MAX_CHARS = 80;
