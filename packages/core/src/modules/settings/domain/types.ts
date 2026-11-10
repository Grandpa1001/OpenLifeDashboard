/**
 * What the resolver needs from a catalog entry. The public catalog in contracts satisfies this
 * shape structurally; core does not import contracts (Architektura §13.3).
 */
type SettingBase = Readonly<{
  key: string;
  editable: boolean;
  apply: "immediate" | "restart";
  stepUp?: boolean;
  envOverride?: string;
}>;

export type SettingDefinition =
  | (SettingBase & Readonly<{ type: "integer"; defaultValue: number; min: number; max: number }>)
  | (SettingBase & Readonly<{ type: "boolean"; defaultValue: boolean }>)
  | (SettingBase & Readonly<{ type: "enum"; defaultValue: string; values: readonly string[] }>)
  | (SettingBase & Readonly<{ type: "time"; defaultValue: string }>);

/** The value of an option: a number, a boolean or a text, by its type. */
export type SettingValue = number | boolean | string;

export type SettingSource = "default" | "db" | "env";

export type EffectiveSetting = Readonly<{
  key: string;
  value: SettingValue;
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
