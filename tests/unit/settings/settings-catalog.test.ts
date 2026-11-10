// D41.1 — the catalog of the application options (Architektura §14.2–§14.3) and the resolver for each type.
// AC1: the catalog is one list: no repeated key or variable, every default inside its own range, an env
//      override only where §14 allows one, the options of §14.3 all present, and the four that ask for a
//      fresh second factor are the ones the table names.
// AC2: the resolver takes and refuses a value of each type (a number, a boolean, a listed text, a time of
//      the day), one bad value rejects the whole set, and an environment variable cannot set a boolean.
import { SETTINGS_CATALOG, TIME_OF_DAY_PATTERN, integerDefault } from "@openlife/contracts/settings";
import { describe, expect, it } from "vitest";
import { acceptsSettingValue, integerSetting, resolveSettings } from "../../../packages/core/src/modules/settings/public.js";

/** The options of §14.3 and §14.2 that are application options, as the table of the architecture names them. */
const EXPECTED_KEYS = [
  "audit.retentionDays",
  "backup.diskReserveMiB",
  "backup.nightlyEnabled",
  "backup.nightlyKeep",
  "backup.safetyKeepDays",
  "backup.time",
  "limits.columnsPerRegistry",
  "limits.configEntries",
  "limits.dictionaries",
  "limits.dictionaryValues",
  "limits.importMaxMiB",
  "limits.jsonBodyKiB",
  "limits.recordMaxKiB",
  "limits.registries",
  "limits.textLength",
  "logs.fileMaxMiB",
  "logs.level",
  "logs.maxFiles",
  "logs.retentionDays",
  "tables.defaultPageSize",
  "updates.checkEnabled",
];
/** "UI + step-up" in §14.3. */
const STEP_UP_KEYS = ["audit.retentionDays", "backup.nightlyEnabled", "backup.nightlyKeep", "backup.safetyKeepDays"];

describe("D41.1-AC1 the catalog of the options", () => {
  it("holds every application option of the architecture once, and nothing else", () => {
    const keys = SETTINGS_CATALOG.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(EXPECTED_KEYS);
  });

  it("gives each option a default inside its own range or list, a label key and the application level", () => {
    for (const definition of SETTINGS_CATALOG) {
      expect(definition.labelKey, definition.key).toMatch(/^settings:options\.[A-Za-z]+$/);
      expect(definition.level).toBe("app");
      expect(acceptsSettingValue(definition, definition.defaultValue), `${definition.key} default`).toBe(true);
      if (definition.type === "integer") expect(definition.min <= definition.defaultValue && definition.defaultValue <= definition.max && definition.min <= definition.max, definition.key).toBe(true);
      if (definition.type === "enum") expect(definition.values.includes(definition.defaultValue), definition.key).toBe(true);
    }
  });

  it("allows an environment variable only for the integer options §14 names, each variable once", () => {
    const withEnv = SETTINGS_CATALOG.filter((definition) => "envOverride" in definition);
    expect(withEnv.map((definition) => definition.key).sort()).toEqual(["backup.diskReserveMiB", "limits.importMaxMiB", "limits.jsonBodyKiB", "limits.recordMaxKiB"]);
    expect(withEnv.every((definition) => definition.type === "integer")).toBe(true);
    const names = withEnv.map((definition) => ("envOverride" in definition ? definition.envOverride : ""));
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks the options that ask for a fresh second factor, and only the one that needs a restart is read-only", () => {
    expect(SETTINGS_CATALOG.filter((definition) => definition.stepUp).map((definition) => definition.key).sort()).toEqual(STEP_UP_KEYS);
    expect(SETTINGS_CATALOG.filter((definition) => !definition.editable).map((definition) => definition.key)).toEqual(["limits.jsonBodyKiB"]);
    expect(integerDefault("limits.jsonBodyKiB")).toBe(256);
    expect(() => integerDefault("logs.level")).toThrow();
  });
});

describe("D41.1-AC2 the resolver for each type", () => {
  const resolve = (database: Record<string, unknown>, environment: Record<string, unknown> = {}) => resolveSettings(SETTINGS_CATALOG, { database, environment });
  const valueOf = (result: ReturnType<typeof resolve>, key: string) => (result.ok ? result.settings.find((setting) => setting.key === key) : undefined);

  it("takes a stored value of every type and says where it came from", () => {
    const result = resolve({ "updates.checkEnabled": false, "logs.level": "debug", "backup.time": "23:45", "limits.registries": 50 });
    expect(valueOf(result, "updates.checkEnabled")).toMatchObject({ value: false, source: "db", editable: true, restartRequired: false });
    expect(valueOf(result, "logs.level")).toMatchObject({ value: "debug", source: "db" });
    expect(valueOf(result, "backup.time")).toMatchObject({ value: "23:45", source: "db" });
    expect(valueOf(result, "limits.registries")).toMatchObject({ value: 50, source: "db" });
    expect(valueOf(result, "logs.maxFiles")).toMatchObject({ source: "default" });
  });

  it("refuses a value of the wrong type or outside what the option allows, and one bad value rejects the whole set", () => {
    for (const bad of [{ "updates.checkEnabled": "true" }, { "updates.checkEnabled": 1 }, { "logs.level": "trace" }, { "logs.level": 3 }, { "backup.time": "24:00" }, { "backup.time": "9:30" }, { "backup.time": "02:60" }, { "limits.registries": 0 }, { "limits.registries": 1.5 }, { "limits.registries": "5" }]) {
      expect(resolve(bad), JSON.stringify(bad)).toEqual({ ok: false, code: "CONFIG_INVALID", fields: Object.keys(bad) });
    }
    expect(resolve({ "limits.registries": 10, "logs.level": "trace" })).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["logs.level"] });
  });

  it("does not let the environment set an option that has no variable, and keeps the lock of the one that has", () => {
    expect(resolve({}, { "updates.checkEnabled": false })).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["updates.checkEnabled"] });
    const locked = valueOf(resolve({ "limits.recordMaxKiB": 100 }, { "limits.recordMaxKiB": 64 }), "limits.recordMaxKiB");
    expect(locked).toMatchObject({ value: 64, source: "env", editable: false, restartRequired: true });
  });

  it("keeps the rule that a record must fit its body, and reads an integer among the effective values", () => {
    expect(resolve({ "limits.recordMaxKiB": 250 })).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["limits.jsonBodyKiB", "limits.recordMaxKiB"] });
    const ok = resolve({});
    expect(ok.ok && integerSetting(ok.settings, "limits.textLength")).toBe(10000);
    expect(ok.ok && integerSetting(ok.settings, "logs.level")).toBeUndefined();
  });

  it("matches the pattern of a time in the catalog and in the resolver", () => {
    for (const time of ["00:00", "02:00", "12:34", "23:59", "24:00", "7:00", "12:60", "12:5", "1200", ""]) {
      const definition = SETTINGS_CATALOG.find((each) => each.key === "backup.time")!;
      expect(acceptsSettingValue(definition, time), time).toBe(TIME_OF_DAY_PATTERN.test(time));
    }
  });
});
