/**
 * What the resolver needs from a catalog entry. The public catalog in contracts satisfies this
 * shape structurally; core does not import contracts (Architektura §13.3).
 */
export type SettingDefinition = Readonly<{
  key: string;
  type: "integer";
  defaultValue: number;
  min: number;
  max: number;
  editable: boolean;
  apply: "immediate" | "restart";
  envOverride?: string;
}>;

export type SettingSource = "default" | "db" | "env";

export type EffectiveSetting = Readonly<{
  key: string;
  value: number;
  source: SettingSource;
  /** False when the option is read-only in the UI or locked by an environment override. */
  editable: boolean;
  restartRequired: boolean;
}>;

/** Raw overrides keyed by setting key: stored DB values and parsed environment values. */
export type SettingOverrides = Readonly<{
  database: Readonly<Record<string, unknown>>;
  environment: Readonly<Record<string, unknown>>;
}>;

export type SettingsResolution =
  | Readonly<{ ok: true; settings: readonly EffectiveSetting[] }>
  | Readonly<{ ok: false; code: "CONFIG_INVALID"; fields: readonly string[] }>;
