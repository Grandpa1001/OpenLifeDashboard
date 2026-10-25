// D03.2 — option resolution (Architektura §14.1, §14.3, §14.5, §18.6).
// AC1: F08 cases assigned to D03.2 give the expected value/source/editable/restartRequired or
//      the exact error, through the env parser plus resolver and through the config-check CLI.
// AC2: a wrong type, an out-of-range or unknown override, or recordMaxKiB + 8 > jsonBodyKiB
//      rejects the whole set without a partial result; core/settings reads no env or files.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../../../apps/server/src/bootstrap/environment.js";
import { resolveBootstrapSettings } from "../../../apps/server/src/bootstrap/settings.js";
import { resolveSettings, type SettingDefinition, type SettingOverrides } from "../../../packages/core/src/modules/settings/public.js";
import { environmentFor, loadBootstrapCases } from "../../support/bootstrap-cases.ts";
import { CONFIG_CHECK_ENTRY, repoRoot, runBuiltScript } from "../../support/server-process.ts";

const fixture = loadBootstrapCases();
const cases = fixture.cases.filter((testCase) => testCase.task === "D03.2");

describe("D03.2-AC1 F08 cases", () => {
  it("covers every D03.2 case of the fixture", () => {
    expect(cases.map((testCase) => testCase.id)).toEqual([
      "database-override",
      "environment-locks-database-value",
      "record-limit-plus-overhead-exceeds-body",
    ]);
  });

  it.each(cases)("$id: environment parser + settings resolver", (testCase) => {
    const { env } = environmentFor(fixture, testCase);
    const environment = parseEnvironment(env);
    expect(environment.ok).toBe(true);
    if (!environment.ok) {
      return;
    }
    const result = resolveBootstrapSettings(environment.config.overrides, testCase.databaseOverrides ?? {});
    const expected = testCase.expected;
    if (expected.kind === "ready") {
      const option = expected.effectiveOption;
      expect(option).toBeDefined();
      expect(result.ok && result.settings.find((setting) => setting.key === option?.key)).toEqual(option);
    } else {
      expect(result).toEqual({ ok: false, code: expected.code, fields: [...expected.fields].sort() });
    }
  });

  it.each(cases.filter((testCase) => testCase.databaseOverrides === undefined))(
    "$id: config-check CLI exit code",
    async (testCase) => {
      const { env } = environmentFor(fixture, testCase);
      const run = await runBuiltScript(CONFIG_CHECK_ENTRY, [], { PATH: process.env["PATH"] ?? "", ...env });
      if (testCase.expected.kind === "error") {
        expect(run.code).toBe(testCase.expected.exitCode);
        const line = JSON.parse(run.output.trim()) as { code: string; fields: string[] };
        expect({ code: line.code, fields: [...line.fields].sort() }).toEqual({
          code: testCase.expected.code,
          fields: [...testCase.expected.fields].sort(),
        });
      } else {
        expect(run.code).toBe(0);
      }
    },
  );
});

describe("D03.2-AC2 the whole set is valid or rejected", () => {
  const resolve = (overrides: Partial<SettingOverrides>) =>
    resolveSettings(SETTINGS_CATALOG, { database: {}, environment: {}, ...overrides });

  it("without overrides every option comes from its catalog default", () => {
    const result = resolve({});
    expect(result.ok).toBe(true);
    expect(result.ok && result.settings.map((s) => [s.key, s.value, s.source])).toEqual(
      SETTINGS_CATALOG.map((definition) => [definition.key, definition.defaultValue, "default"]),
    );
  });

  it.each([
    ["a numeric string", "256"],
    ["a fraction", 256.5],
    ["null", null],
    ["a boolean", true],
    ["below the minimum", 127],
    ["above the maximum", 10241],
  ])("a stored value that is %s → CONFIG_INVALID without settings", (_label, value) => {
    const result = resolve({ database: { "backup.diskReserveMiB": value } });
    expect(result).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["backup.diskReserveMiB"] });
    expect("settings" in result).toBe(false);
  });

  it("an out-of-range environment value is reported by its variable name", () => {
    expect(resolve({ environment: { "limits.importMaxMiB": 501 } })).toEqual({
      ok: false,
      code: "CONFIG_INVALID",
      fields: ["IMPORT_MAX_MIB"],
    });
  });

  it("a valid environment value does not hide an invalid stored value", () => {
    const result = resolve({ database: { "backup.diskReserveMiB": "x" }, environment: { "backup.diskReserveMiB": 1024 } });
    expect(result).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["backup.diskReserveMiB"] });
  });

  it("unknown keys and environment overrides of options without one are rejected", () => {
    const catalog: readonly SettingDefinition[] = [
      { key: "a.locked", type: "integer", defaultValue: 1, min: 0, max: 9, editable: true, apply: "immediate" },
    ];
    expect(resolveSettings(catalog, { database: { "x.unknown": 1 }, environment: { "a.locked": 2 } })).toEqual({
      ok: false,
      code: "CONFIG_INVALID",
      fields: ["a.locked", "x.unknown"],
    });
  });

  it("recordMaxKiB + 8 must fit jsonBodyKiB, also when both come from the database", () => {
    expect(resolve({ database: { "limits.recordMaxKiB": 249 } })).toEqual({
      ok: false,
      code: "CONFIG_INVALID",
      fields: ["limits.jsonBodyKiB", "limits.recordMaxKiB"],
    });
    const boundary = resolve({ database: { "limits.recordMaxKiB": 248 } });
    expect(boundary.ok).toBe(true);
  });

  it("does not modify the override maps it receives", () => {
    const database = Object.freeze({ "limits.recordMaxKiB": 100 });
    const environment = Object.freeze({ "backup.diskReserveMiB": 1024 });
    expect(() => resolveSettings(SETTINGS_CATALOG, { database, environment })).not.toThrow();
    expect(database).toEqual({ "limits.recordMaxKiB": 100 });
  });

  it("core/settings sources reference no environment, file system or Node built-ins", () => {
    const dir = path.join(repoRoot, "packages/core/src/modules/settings");
    const sources = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(path.join(dir, file), "utf8"));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).not.toMatch(/\bprocess\b|from "node:|from "fs"|readFileSync|import\.meta/);
    }
  });
});
