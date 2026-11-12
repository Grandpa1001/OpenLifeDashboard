// D45.1 — the parser of the export file and its canonical form (Architektura Załącznik G; DEV §9.42).
// AC1: the F01 fixture passes; a file over the limit, not JSON, of another format, of a newer or a broken version
//      is refused with its code; an older version is migrated by the chain.
// AC2: a problem in any section has the path in the file and a stable code (shape, symbols, names, types,
//      defaults, values of records, positions, limits), a repeated identifier and a reference to a
//      dictionary that is not in the file are found, a binding may point at what the file does not hold, the
//      list of issues is bounded, and the canonical form does not depend on the order of the arrays.
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXPORT_FORMAT_VERSION, type ExportFile } from "../../../packages/contracts/src/export/format.js";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { describe, expect, it } from "vitest";
import { canonicalExport } from "../../../apps/server/src/portability/canonical.js";
import { parseExportFile, type ParseExportOptions, type ParseExportResult } from "../../../apps/server/src/portability/parse-export.js";
import { repoRoot } from "../../support/server-process.ts";

const FIXTURE_TEXT = readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8");
const OPTIONS: ParseExportOptions = { maxBytes: 100 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };

/** A fresh copy of the fixture to break in one place. */
const fixture = (): Record<string, any> => JSON.parse(FIXTURE_TEXT) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const parse = (file: unknown, options: Partial<ParseExportOptions> = {}): ParseExportResult => parseExportFile(JSON.stringify(file), { ...OPTIONS, ...options });
const issuesOf = (result: ParseExportResult): string[] => (result.ok ? [] : result.issues.map((issue) => `${issue.path} ${issue.code}`));
const failed = (result: ParseExportResult) => (result.ok ? null : result);

describe("D45.1-AC1 what is accepted and what is refused before the content is read", () => {
  it("accepts the F01 fixture, as text, as bytes and with a byte order mark, and returns the file as it is", () => {
    const text = parseExportFile(FIXTURE_TEXT, OPTIONS);
    expect(text.ok).toBe(true);
    if (text.ok) {
      expect(text.migratedFrom).toBeNull();
      expect(text.file).toEqual(JSON.parse(FIXTURE_TEXT));
      expect(text.file.registries[0]?.records).toHaveLength(25);
    }
    expect(parseExportFile(new TextEncoder().encode(FIXTURE_TEXT), OPTIONS).ok).toBe(true);
    expect(parseExportFile(`\uFEFF${FIXTURE_TEXT}`, OPTIONS).ok).toBe(true);
  });

  it("refuses a file over the limit and accepts one of exactly the limit", () => {
    const size = Buffer.byteLength(FIXTURE_TEXT);
    expect(failed(parseExportFile(FIXTURE_TEXT, { ...OPTIONS, maxBytes: size - 1 }))).toMatchObject({ code: "EXPORT_TOO_LARGE" });
    expect(parseExportFile(FIXTURE_TEXT, { ...OPTIONS, maxBytes: size }).ok).toBe(true);
    // The size is counted in bytes, not characters.
    expect(failed(parseExportFile("ż".repeat(10), { ...OPTIONS, maxBytes: 15 }))).toMatchObject({ code: "EXPORT_TOO_LARGE" });
  });

  it("refuses what is not JSON, and JSON that is not an export of this product", () => {
    for (const text of ["", "{", "not json", '{"format": "openlifedashboard-export",']) expect(failed(parseExportFile(text, OPTIONS)), text).toMatchObject({ code: "EXPORT_NOT_JSON" });
    for (const value of [[], null, 7, "text", {}, { format: "something-else", formatVersion: 1 }, { formatVersion: 1 }, { format: "openlifedashboard-screen-template", formatVersion: 1 }]) {
      expect(failed(parse(value)), JSON.stringify(value)).toMatchObject({ code: "EXPORT_FORMAT_UNKNOWN" });
    }
  });

  it("refuses a newer version and a version that is not one", () => {
    expect(failed(parse({ ...fixture(), formatVersion: EXPORT_FORMAT_VERSION + 1 }))).toMatchObject({ code: "EXPORT_VERSION_NEWER", issues: [{ path: "formatVersion" }] });
    for (const version of [-1, 1.5, "1", null, undefined, true]) expect(failed(parse({ ...fixture(), formatVersion: version })), String(version)).toMatchObject({ code: "EXPORT_VERSION_UNSUPPORTED" });
  });

  it("migrates an older version by the chain, step by step, and refuses a chain with a gap", () => {
    const older: Record<string, unknown> = { ...fixture(), formatVersion: 0 };
    delete older["settings"];
    older["preferences"] = fixture()["settings"];
    const migrations = new Map([
      [
        0,
        (file: Readonly<Record<string, unknown>>) => {
          const { preferences, ...rest } = file;
          return { ...rest, formatVersion: 1, settings: preferences };
        },
      ],
    ]);
    const migrated = parse(older, { migrations });
    expect(migrated.ok).toBe(true);
    if (migrated.ok) expect(migrated).toMatchObject({ migratedFrom: 0, file: { formatVersion: 1, settings: fixture()["settings"] } });
    // Without the step the file of the older format cannot be read.
    expect(failed(parse(older))).toMatchObject({ code: "EXPORT_VERSION_UNSUPPORTED" });
    // A step that leaves the file broken is not trusted: the shape is checked after it.
    expect(failed(parse(older, { migrations: new Map([[0, (file: Readonly<Record<string, unknown>>) => ({ ...file, formatVersion: 1 })]]) }))).toMatchObject({ code: "EXPORT_INVALID" });
  });
});

describe("D45.1-AC2 the issues have a path and a code", () => {
  it("names the field that the shape refuses, whatever the depth, and the fields that must not be there", () => {
    const file = fixture();
    file["userId"] = "forged";
    file["registries"][0]["columns"][1]["type"] = "colour";
    file["registries"][0]["records"][3]["user_id"] = "019a0000-0000-7000-8000-0000000000aa";
    file["screens"][0]["widgets"][1]["layout"]["phone"]["w"] = 0;
    delete file["settings"]["locale"];
    file["configEntries"][0]["id"] = "not-an-id";
    const issues = issuesOf(parse(file));
    expect(issues).toEqual(
      expect.arrayContaining([
        "userId SHAPE_UNKNOWN_FIELD",
        "registries[0].columns[1].type SHAPE_VALUE",
        "registries[0].records[3].user_id SHAPE_UNKNOWN_FIELD",
        "screens[0].widgets[1].layout.phone.w SHAPE_RANGE",
        "settings.locale SHAPE_VALUE",
        "configEntries[0].id SHAPE_FORMAT",
      ]),
    );
    expect(failed(parse(file))).toMatchObject({ code: "EXPORT_INVALID" });
  });

  it("holds no authentication data, audit or flags of the application in the shape", () => {
    for (const field of ["sessions", "totp", "recoveryCodes", "trustedDevices", "audit", "auditLog", "backups", "instanceState", "user_id", "userId"]) {
      const file = fixture();
      file[field] = [];
      expect(issuesOf(parse(file)), field).toContain(`${field} SHAPE_UNKNOWN_FIELD`);
    }
  });

  it("applies the rules of the catalogs to symbols, names and the columns of a registry", () => {
    const file = fixture();
    const second = structuredClone(file["registries"][0]);
    second["id"] = "019a0000-0000-7000-8000-0000000fff01";
    second["columns"].forEach((column: Record<string, unknown>, index: number) => (column["id"] = `019a0000-0000-7000-8000-0000000fff1${index}`));
    second["records"] = [];
    file["registries"].push(second);
    file["registries"][0]["columns"][2]["symbol"] = "Bad Symbol";
    file["registries"][0]["columns"][3]["symbol"] = "tytul";
    file["registries"][0]["columns"][4]["displayName"] = "   ";
    file["registries"][0]["columns"][5]["defaultValue"] = "not a number";
    file["registries"][0]["columns"][6]["typeOptions"] = { decimalPlaces: 99 };
    file["registries"][0]["columns"][1]["position"] = 5;
    const issues = issuesOf(parse(file));
    expect(issues).toEqual(
      expect.arrayContaining([
        "registries[1].symbol SYMBOL_TAKEN",
        "registries[0].columns[2].symbol SYMBOL_PATTERN",
        "registries[0].columns[3].symbol SYMBOL_TAKEN",
        "registries[0].columns[4].displayName NAME_EMPTY",
        "registries[0].columns[5].defaultValue DEFAULT_INVALID",
        "registries[0].columns[1].position POSITION_INVALID",
      ]),
    );
    expect(issues.some((issue) => issue.startsWith("registries[0].columns[6].typeOptions"))).toBe(true);
  });

  it("applies the rules of the catalogs to dictionaries and the entries of ConfigTable", () => {
    const file = fixture();
    file["dictionaries"][0]["values"][1]["symbol"] = file["dictionaries"][0]["values"][0]["symbol"];
    file["dictionaries"][0]["values"][2]["position"] = 7;
    file["dictionaries"][0]["displayName"] = "";
    file["configEntries"].push({ ...file["configEntries"][0], id: "019a0000-0000-7000-8000-0000000fff02" });
    file["configEntries"][0]["value"] = "x".repeat(10_001);
    const issues = issuesOf(parse(file));
    expect(issues.some((issue) => issue.startsWith("dictionaries[0].values") && issue.endsWith("SYMBOL_TAKEN"))).toBe(true);
    expect(issues).toEqual(expect.arrayContaining(["dictionaries[0].values[2].position POSITION_INVALID", "dictionaries[0].displayName NAME_EMPTY", "configEntries[1].symbol SYMBOL_TAKEN", "configEntries[0].value VALUE_TOO_LONG"]));
  });

  it("checks every value of every record by the type of its column", () => {
    const file = fixture();
    const columns = file["registries"][0]["columns"] as Array<{ symbol: string; type: string; required: boolean }>;
    const required = columns.find((column) => column.required)?.symbol ?? "";
    const records = file["registries"][0]["records"];
    records[0]["values"]["strony"] = "ten";
    delete records[1]["values"]["autor"];
    records[2]["values"]["unknown_column"] = 1;
    records[3]["values"][required] = null;
    records[4]["updatedAt"] = "2020-01-01T00:00:00Z";
    records[5]["values"]["ponowne_czytanie"] = "yes";
    const issues = issuesOf(parse(file));
    expect(issues).toEqual(
      expect.arrayContaining([
        "registries[0].records[0].values.strony VALUE_INVALID",
        "registries[0].records[1].values.autor VALUE_MISSING",
        "registries[0].records[2].values.unknown_column FIELD_UNKNOWN",
        `registries[0].records[3].values.${required} VALUE_REQUIRED`,
        "registries[0].records[4].updatedAt TIMESTAMPS_ORDER",
        "registries[0].records[5].values.ponowne_czytanie VALUE_INVALID",
      ]),
    );
  });

  it("finds an identifier used twice anywhere in the file, and a column that names a dictionary the file does not hold", () => {
    const file = fixture();
    file["registries"][0]["records"][0]["id"] = file["registries"][0]["columns"][0]["id"];
    file["screens"][0]["widgets"][1]["id"] = file["screens"][0]["widgets"][0]["id"];
    file["configEntries"][0]["id"] = file["dictionaries"][0]["id"];
    const choice = (file["registries"][0]["columns"] as Array<{ type: string; typeOptions: Record<string, unknown> }>).findIndex((column) => column.type === "choice");
    file["registries"][0]["columns"][choice]["typeOptions"] = { dictionaryId: "019a0000-0000-7000-8000-0000000fffff" };
    const issues = issuesOf(parse(file));
    expect(issues).toEqual(
      expect.arrayContaining(["registries[0].records[0].id ID_DUPLICATE", "screens[0].widgets[1].id ID_DUPLICATE", "dictionaries[0].id ID_DUPLICATE", `registries[0].columns[${choice}].typeOptions.dictionaryId DICTIONARY_UNKNOWN`]),
    );
  });

  it("applies the limits it is given: registries, columns, entries, dictionaries, screens and widgets", () => {
    const file = fixture();
    expect(issuesOf(parse(file, { registry: { ...DEFAULT_REGISTRY_LIMITS, maxRegistries: 0 } }))).toContain("registries[0] LIMIT_REGISTRIES");
    expect(issuesOf(parse(file, { registry: { ...DEFAULT_REGISTRY_LIMITS, maxColumns: 3 } }))).toContain("registries[0].columns LIMIT_COLUMNS");
    expect(issuesOf(parse(file, { registry: { ...DEFAULT_REGISTRY_LIMITS, textMaxChars: 12 } })).some((issue) => issue.includes(".values.") && issue.endsWith("VALUE_INVALID"))).toBe(true);
    expect(issuesOf(parse(file, { dictionary: { maxDictionaries: 0, maxValues: 500 } }))).toContain("dictionaries[0] LIMIT_DICTIONARIES");
    expect(issuesOf(parse(file, { dictionary: { maxDictionaries: 200, maxValues: 2 } }))).toContain("dictionaries[0].values LIMIT_VALUES");
    expect(issuesOf(parse(file, { config: { ...DEFAULT_CONFIG_LIMITS, maxEntries: 0 } }))).toContain("configEntries[0] LIMIT_ENTRIES");
    expect(issuesOf(parse(file, { recordMaxBytes: 20 })).some((issue) => issue.endsWith("RECORD_TOO_LARGE"))).toBe(true);
    const crowded = fixture();
    crowded["screens"].push({ ...structuredClone(crowded["screens"][0]), id: "019a0000-0000-7000-8000-0000000fff03", widgets: [] });
    expect(issuesOf(parse(crowded))).toContain("screens LIMIT_SCREENS");
    const wide = fixture();
    wide["screens"][0]["widgets"] = Array.from({ length: 51 }, (_, n) => ({ ...structuredClone(wide["screens"][0]["widgets"][1]), id: `019a0000-0000-7000-8000-0000000fe${String(n).padStart(3, "0")}` }));
    expect(issuesOf(parse(wide))).toContain("screens[0].widgets LIMIT_WIDGETS");
  });

  it("accepts a binding that points at what the file does not hold, and refuses two on the same place", () => {
    const file = fixture();
    const bindings = file["screens"][0]["widgets"][0]["bindings"] as Array<Record<string, unknown>>;
    bindings.push({ slot: "columns", ordinal: 9, path: "Field.Register.gone.col", target: { kind: "column", registryId: "019a0000-0000-7000-8000-0000000fffaa", columnId: "019a0000-0000-7000-8000-0000000fffab" } });
    bindings.push({ slot: "config", ordinal: 0, path: "Field.Config.gone", target: { kind: "config", entryId: "019a0000-0000-7000-8000-0000000fffac" } });
    expect(parse(file).ok).toBe(true);
    bindings.push({ ...bindings[1], path: "Field.Register.ksiazki.autor" });
    expect(issuesOf(parse(file))).toContain(`screens[0].widgets[0].bindings[${bindings.length - 1}].ordinal ORDINAL_DUPLICATE`);
  });

  it("lists at most a bounded number of issues, and changes nothing of what it was given", () => {
    const file = fixture();
    file["registries"][0]["records"] = Array.from({ length: 300 }, (_, n) => ({ id: `019a0000-0000-7000-8000-0000001${String(n).padStart(5, "0")}`, revision: 1, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z", values: { tytul: 5 } }));
    const text = JSON.stringify(file);
    const result = parseExportFile(text, OPTIONS);
    expect(failed(result)?.issues.length).toBe(100);
    expect(text).toBe(JSON.stringify(file));
  });
});

describe("D45.1-AC2 the canonical form", () => {
  const load = (): ExportFile => (parseExportFile(FIXTURE_TEXT, OPTIONS) as Extract<ParseExportResult, { ok: true }>).file;

  it("leaves out the time of the export and does not depend on the order of the arrays", () => {
    const original = load();
    const shuffled = structuredClone(original);
    shuffled.exportedAt = "2030-01-01T00:00:00Z";
    shuffled.configEntries.reverse();
    shuffled.dictionaries.reverse();
    for (const dictionary of shuffled.dictionaries) dictionary.values.reverse();
    for (const registry of shuffled.registries) {
      registry.columns.reverse();
      registry.records.reverse();
    }
    for (const screen of shuffled.screens) {
      screen.widgets.reverse();
      for (const widget of screen.widgets) widget.bindings.reverse();
    }
    expect(canonicalExport(shuffled)).toBe(canonicalExport(original));
    expect(canonicalExport(original)).not.toContain("exportedAt");
  });

  it("changes with a value, a revision, the position of a column or the ordinal of a binding", () => {
    const base = canonicalExport(load());
    const changed = (edit: (file: ExportFile) => void): string => {
      const file = structuredClone(load());
      edit(file);
      return canonicalExport(file);
    };
    expect(changed((file) => void (file.registries[0]!.records[0]!.values["tytul"] = "Inny tytuł"))).not.toBe(base);
    expect(changed((file) => void (file.registries[0]!.records[0]!.revision += 1))).not.toBe(base);
    expect(changed((file) => void (file.registries[0]!.columns[0]!.position = 99))).not.toBe(base);
    expect(changed((file) => void (file.screens[0]!.widgets[0]!.bindings[1]!.ordinal = 8))).not.toBe(base);
    expect(changed((file) => void (file.settings.timezone = "UTC"))).not.toBe(base);
    expect(changed((file) => void (file.appVersion = "9.9.9"))).not.toBe(base);
  });
});
