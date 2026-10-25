// Public catalog of configurable application options (Architektura §14.1, §14.3). It is the
// single definition of key, type, default, range, editability, how a change applies and the
// environment override allowed for it. Secrets are never described here (§14.5).
// D03.2 contains the options read at bootstrap; D41 extends the catalog with the rest of §14.

export type IntegerSettingDefinition = Readonly<{
  key: string;
  type: "integer";
  defaultValue: number;
  min: number;
  max: number;
  unit: "KiB" | "MiB";
  level: "app";
  /** Whether the owner may change it in the UI (D41/D42); deployment options stay read-only. */
  editable: boolean;
  /** "immediate": used as soon as it is saved; "restart": takes effect after a restart. */
  apply: "immediate" | "restart";
  stepUp: boolean;
  /** Installation environment variable allowed to override the value; it locks the option. */
  envOverride?: string;
  labelKey: string;
}>;

export type SettingDefinition = IntegerSettingDefinition;

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
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTINGS_CATALOG)[number]["key"];
