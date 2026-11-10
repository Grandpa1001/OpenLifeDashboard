// Public catalog of configurable application options (Architektura §14.1, §14.3). It is the
// single definition of key, type, default, range, editability, how a change applies and the
// environment override allowed for it. Secrets are never described here (§14.5).
// D03.2 contains the options read at bootstrap, D06.2 adds the log rotation limits, D41.1 the rest of
// the application options of §14.2–§14.3 and the types they need. The personal options of the owner
// (zone, language) live in `owner_settings`, the accent in the screen; they are not in this catalog.

/** What every option says of itself, whatever its type. */
type SettingBase = Readonly<{
  key: string;
  level: "app";
  /** Whether the owner may change it in the UI (D41/D42); deployment options stay read-only. */
  editable: boolean;
  /** "immediate": used as soon as it is saved; "restart": takes effect after a restart. */
  apply: "immediate" | "restart";
  /** A change asks for a fresh second factor (D43); until then the API refuses it. */
  stepUp: boolean;
  /** Installation environment variable allowed to override the value; it locks the option. Integer options only. */
  envOverride?: string;
  labelKey: string;
}>;

export type IntegerSettingDefinition = SettingBase &
  Readonly<{
    type: "integer";
    defaultValue: number;
    min: number;
    max: number;
    unit: "KiB" | "MiB" | "files" | "days" | "backups" | "characters" | "count" | "rows";
  }>;

export type BooleanSettingDefinition = SettingBase & Readonly<{ type: "boolean"; defaultValue: boolean }>;

export type EnumSettingDefinition = SettingBase & Readonly<{ type: "enum"; defaultValue: string; values: readonly string[] }>;

/** A time of the day as `HH:MM` (24 hours), in the zone of the owner. */
export type TimeSettingDefinition = SettingBase & Readonly<{ type: "time"; defaultValue: string }>;

export type SettingDefinition = IntegerSettingDefinition | BooleanSettingDefinition | EnumSettingDefinition | TimeSettingDefinition;

/** The value of an option: a number, a boolean or a text, by its type. */
export type SettingValue = number | boolean | string;

/** `HH:MM`, 00:00 to 23:59. */
export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const SETTINGS_CATALOG = [
  {
    key: "backup.diskReserveMiB",
    type: "integer",
    defaultValue: 512,
    min: 128,
    max: 10240,
    unit: "MiB",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: false,
    envOverride: "BACKUP_DISK_RESERVE_MIB",
    labelKey: "settings:options.backupDiskReserve",
  },
  {
    key: "limits.importMaxMiB",
    type: "integer",
    defaultValue: 100,
    min: 1,
    max: 500,
    unit: "MiB",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: false,
    envOverride: "IMPORT_MAX_MIB",
    labelKey: "settings:options.importMax",
  },
  {
    key: "limits.recordMaxKiB",
    type: "integer",
    defaultValue: 192,
    min: 1,
    max: 1024,
    unit: "KiB",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: false,
    envOverride: "RECORD_MAX_KIB",
    labelKey: "settings:options.recordMax",
  },
  {
    key: "limits.jsonBodyKiB",
    type: "integer",
    defaultValue: 256,
    min: 16,
    max: 2048,
    unit: "KiB",
    level: "app",
    // Must match the server and proxy request limit, so it changes only with a restart.
    editable: false,
    apply: "restart",
    stepUp: false,
    envOverride: "JSON_BODY_KIB",
    labelKey: "settings:options.jsonBody",
  },
  {
    key: "logs.fileMaxMiB",
    type: "integer",
    defaultValue: 10,
    min: 1,
    max: 50,
    unit: "MiB",
    level: "app",
    editable: true,
    // Read at each rotation decision, so a change takes effect with the next rotation.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.logsFileMax",
  },
  {
    key: "logs.maxFiles",
    type: "integer",
    defaultValue: 5,
    min: 2,
    max: 20,
    unit: "files",
    level: "app",
    editable: true,
    // Per service and including the active file.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.logsMaxFiles",
  },
  {
    key: "logs.retentionDays",
    type: "integer",
    defaultValue: 14,
    min: 1,
    max: 90,
    unit: "days",
    level: "app",
    editable: true,
    // Deletes only rotated log files, never the database or backups.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.logsRetention",
  },
  {
    key: "updates.checkEnabled",
    type: "boolean",
    defaultValue: true,
    level: "app",
    editable: true,
    // Switching it off does not block "Check now".
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.updatesCheck",
  },
  {
    key: "backup.nightlyEnabled",
    type: "boolean",
    defaultValue: true,
    level: "app",
    editable: true,
    // The mandatory copies before an update or a structure change are made whatever this says.
    apply: "immediate",
    stepUp: true,
    labelKey: "settings:options.backupNightly",
  },
  {
    key: "backup.time",
    type: "time",
    defaultValue: "02:00",
    level: "app",
    editable: true,
    // In the zone of the owner; the new time counts from the next due moment.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.backupTime",
  },
  {
    key: "backup.nightlyKeep",
    type: "integer",
    defaultValue: 14,
    min: 2,
    max: 90,
    unit: "backups",
    level: "app",
    editable: true,
    // Retention touches only finished nightly copies.
    apply: "immediate",
    stepUp: true,
    labelKey: "settings:options.backupNightlyKeep",
  },
  {
    key: "backup.safetyKeepDays",
    type: "integer",
    defaultValue: 30,
    min: 7,
    max: 365,
    unit: "days",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: true,
    labelKey: "settings:options.backupSafetyKeepDays",
  },
  {
    key: "audit.retentionDays",
    type: "integer",
    defaultValue: 90,
    min: 30,
    max: 365,
    unit: "days",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: true,
    labelKey: "settings:options.auditRetention",
  },
  {
    key: "logs.level",
    type: "enum",
    defaultValue: "info",
    values: ["error", "warn", "info", "debug"],
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.logsLevel",
  },
  {
    key: "limits.registries",
    type: "integer",
    defaultValue: 200,
    min: 1,
    max: 1000,
    unit: "count",
    level: "app",
    editable: true,
    // Limits creation only; nothing existing is removed.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.limitRegistries",
  },
  {
    key: "limits.columnsPerRegistry",
    type: "integer",
    defaultValue: 60,
    min: 1,
    max: 100,
    unit: "count",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.limitColumns",
  },
  {
    key: "limits.textLength",
    type: "integer",
    defaultValue: 10000,
    min: 1,
    max: 100000,
    unit: "characters",
    level: "app",
    editable: true,
    // Counts Unicode code points; a lower limit never trims data that is already stored.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.limitTextLength",
  },
  {
    key: "limits.dictionaries",
    type: "integer",
    defaultValue: 200,
    min: 1,
    max: 1000,
    unit: "count",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.limitDictionaries",
  },
  {
    key: "limits.dictionaryValues",
    type: "integer",
    defaultValue: 500,
    min: 1,
    max: 5000,
    unit: "count",
    level: "app",
    editable: true,
    // Per dictionary.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.limitDictionaryValues",
  },
  {
    key: "limits.configEntries",
    type: "integer",
    defaultValue: 500,
    min: 1,
    max: 5000,
    unit: "count",
    level: "app",
    editable: true,
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.limitConfigEntries",
  },
  {
    key: "tables.defaultPageSize",
    type: "integer",
    defaultValue: 25,
    min: 10,
    max: 100,
    unit: "rows",
    level: "app",
    editable: true,
    // The page size of the tables of the application; it does not override the page size of a widget.
    apply: "immediate",
    stepUp: false,
    labelKey: "settings:options.tablesDefaultPageSize",
  },
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTINGS_CATALOG)[number]["key"];

/** The default of an integer option, for code that needs a number before the settings are read. */
export function integerDefault(key: string): number {
  const definition = SETTINGS_CATALOG.find((candidate) => candidate.key === key);
  if (definition === undefined || definition.type !== "integer") throw new Error(`the option ${key} is not an integer option of the catalog`);
  return definition.defaultValue;
}
