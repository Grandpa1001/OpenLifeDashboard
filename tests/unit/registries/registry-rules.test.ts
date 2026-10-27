// D14.1 — the rules of the registry catalog that need no database (Architektura §4.3, §5.1,
// Załącznik C). AC1: the symbols and their suggestion; AC2: types, options, defaults and limits.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkSymbol,
  DEFAULT_REGISTRY_LIMITS,
  isValidDefault,
  normalizeTypeOptions,
  RESERVED_COLUMN_SYMBOLS,
  suggestSymbol,
  validateNewRegistry,
  type ColumnType,
  type RegistryContext,
  type RegistryDraft,
} from "../../../packages/core/dist/modules/registries/public.js";
import { repoRoot } from "../../support/server-process.ts";

const NONE: ReadonlySet<string> = new Set();
const context = (over: Partial<RegistryContext> = {}): RegistryContext => ({ limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: NONE, activeRegistryCount: 0, ...over });

describe("D14.1-AC1 symbols and their suggestion", () => {
  it.each([
    ["Książki przeczytane", "ksiazki_przeczytane"],
    ["Książki przeczytane 2026!", "ksiazki_przeczytane_2026"],
    ["2026 cele", "cele"],
    ["Waga (kg)", "waga_kg"],
    ["Data", "data"],
    ["Żółć", "zolc"],
    ["___", "pole"],
  ])("the suggestion for %j is %j (Załącznik C)", (name, expected) => {
    expect(suggestSymbol(name, "column", NONE)).toBe(expected);
    expect(suggestSymbol(name, "registry", NONE)).toBe(expected);
  });

  it("ID is reserved for a column, so its suggestion is id_2; for a registry it is free", () => {
    expect(suggestSymbol("ID", "column", NONE)).toBe("id_2");
    expect(suggestSymbol("ID", "registry", NONE)).toBe("id");
  });

  it("a collision counts up: _2, _3, … and the suffix fits the 40 characters", () => {
    expect(suggestSymbol("Książki", "registry", new Set(["ksiazki"]))).toBe("ksiazki_2");
    expect(suggestSymbol("Książki", "registry", new Set(["ksiazki", "ksiazki_2"]))).toBe("ksiazki_3");
    const long = "a".repeat(45);
    const base = suggestSymbol(long, "registry", NONE);
    expect(base).toBe("a".repeat(40));
    const next = suggestSymbol(long, "registry", new Set([base]));
    expect(next).toBe(`${"a".repeat(38)}_2`);
    expect(next.length).toBeLessThanOrEqual(40);
  });

  it("whatever the name, the suggestion is a valid symbol of its space", () => {
    for (const name of ["", "   ", "---", "😀😀", "ŁÓDŹ — miasto", "  Tytuł  ", "a.b-c d", "x".repeat(200), "İstanbul", "_start_", "99 problems", "Select", "DROP TABLE; --"]) {
      for (const space of ["registry", "column"] as const) {
        const symbol = suggestSymbol(name, space, NONE);
        expect(checkSymbol(symbol, space, NONE), `${JSON.stringify(name)} → ${symbol}`).toBeNull();
      }
    }
  });

  it("good symbols pass; each way of being wrong has its own code", () => {
    for (const symbol of ["a", "ksiazki", "data_ukonczenia", "x1", "a_1_b2", "a".repeat(40)]) expect(checkSymbol(symbol, "column", NONE)).toBeNull();
    const wrong: ReadonlyArray<readonly [string, string]> = [
      ["", "SYMBOL_PATTERN"],
      ["Ksiazki", "SYMBOL_PATTERN"],
      ["1abc", "SYMBOL_PATTERN"],
      ["_abc", "SYMBOL_PATTERN"],
      ["abc_", "SYMBOL_PATTERN"],
      ["a__b", "SYMBOL_PATTERN"],
      ["a-b", "SYMBOL_PATTERN"],
      ["a b", "SYMBOL_PATTERN"],
      ["książki", "SYMBOL_PATTERN"],
      ["x; DROP TABLE user", "SYMBOL_PATTERN"],
      ['x"y', "SYMBOL_PATTERN"],
      ["x'y", "SYMBOL_PATTERN"],
      ["x\ny", "SYMBOL_PATTERN"],
      ["reg_x`", "SYMBOL_PATTERN"],
      ["a".repeat(41), "SYMBOL_TOO_LONG"],
    ];
    for (const [symbol, code] of wrong) expect([symbol, checkSymbol(symbol, "registry", NONE)]).toEqual([symbol, code]);
  });

  it("the words reserved for columns are refused there and free for a registry; the keywords of SQL are among them", () => {
    for (const word of ["id", "user_id", "created_at", "updated_at", "revision", "select", "table", "order", "group", "index", "key", "values", "default", "rowid"]) {
      expect(checkSymbol(word, "column", NONE), word).toBe("SYMBOL_RESERVED");
      expect(RESERVED_COLUMN_SYMBOLS.has(word)).toBe(true);
    }
    for (const word of ["data", "date", "status", "text", "title"]) expect(checkSymbol(word, "column", NONE), word).toBeNull();
    expect(checkSymbol("order", "registry", NONE)).toBeNull();
  });

  it("uniqueness is per space: the same symbol is free in another one", () => {
    expect(checkSymbol("ksiazki", "registry", new Set(["ksiazki"]))).toBe("SYMBOL_TAKEN");
    expect(checkSymbol("ksiazki", "column", new Set(["tytul"]))).toBeNull();
  });
});

const BOOKS = (): RegistryDraft => {
  const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as {
    registries: Array<{ symbol: string; displayName: string; columns: Array<Record<string, unknown>> }>;
  };
  const books = fixture.registries[0];
  if (books === undefined) throw new Error("F01 has no registry");
  return { symbol: books.symbol, displayName: books.displayName, columns: books.columns };
};

describe("D14.1-AC2 types, options, defaults and limits", () => {
  it("the registry of F01 (nine columns, eight types) is a valid definition and keeps its order", () => {
    const result = validateNewRegistry(BOOKS(), context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbol).toBe("ksiazki");
    expect(result.value.columns.map((column) => column.symbol)).toEqual(["tytul", "autor", "strony", "cena", "data_ukonczenia", "rozpoczeto", "przypomnienie", "ponowne_czytanie", "status"]);
    expect(result.value.columns.map((column) => column.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(result.value.columns.map((column) => column.type)).size).toBe(8);
    expect(result.value.columns[0]).toMatchObject({ required: true, defaultValue: null });
    expect(result.value.columns[8]).toMatchObject({ type: "choice", defaultValue: "planowane" });
  });

  it("a required column of a new registry needs no default", () => {
    const result = validateNewRegistry({ symbol: "a", displayName: "A", columns: [{ symbol: "x", displayName: "X", type: "text", required: true }] }, context());
    expect(result.ok).toBe(true);
  });

  it("type options: number carries decimalPlaces 0–6 (0 when absent), choice an optional dictionaryId, the rest nothing, and nothing unknown", () => {
    expect(normalizeTypeOptions("number", {})).toEqual({ decimalPlaces: 0 });
    expect(normalizeTypeOptions("number", { decimalPlaces: 6 })).toEqual({ decimalPlaces: 6 });
    for (const bad of [{ decimalPlaces: 7 }, { decimalPlaces: -1 }, { decimalPlaces: 1.5 }, { decimalPlaces: "2" }, { decimalPlaces: 2, extra: 1 }, { dictionaryId: "x" }]) {
      expect(normalizeTypeOptions("number", bad), JSON.stringify(bad)).toBeNull();
    }
    expect(normalizeTypeOptions("choice", {})).toEqual({});
    expect(normalizeTypeOptions("choice", { dictionaryId: "d1" })).toEqual({ dictionaryId: "d1" });
    for (const bad of [{ dictionaryId: "" }, { dictionaryId: 5 }, { dictionaryId: "a".repeat(65) }, { decimalPlaces: 1 }]) expect(normalizeTypeOptions("choice", bad), JSON.stringify(bad)).toBeNull();
    for (const type of ["text", "money", "date", "datetime", "time", "boolean"] as const) {
      expect(normalizeTypeOptions(type, {})).toEqual({});
      expect(normalizeTypeOptions(type, { decimalPlaces: 2 }), type).toBeNull();
    }
    for (const notAnObject of [null, "x", 5, [], [1]]) expect(normalizeTypeOptions("text", notAnObject)).toBeNull();
    expect(normalizeTypeOptions("text", Object.create({ inherited: 1 }))).toBeNull();
  });

  const GOOD: ReadonlyArray<readonly [ColumnType, unknown, Record<string, unknown>?]> = [
    ["text", "x"],
    ["text", ""],
    ["number", 3, { decimalPlaces: 0 }],
    ["number", 3.25, { decimalPlaces: 2 }],
    ["money", 1037],
    ["money", -50],
    ["date", "2026-02-28"],
    ["date", "2028-02-29"],
    ["datetime", "2026-10-01T12:01:00Z"],
    ["datetime", "2026-10-01T12:01:00.250Z"],
    ["time", "00:00"],
    ["time", "23:59"],
    ["boolean", false],
    ["choice", "planowane"],
  ];
  const BAD: ReadonlyArray<readonly [ColumnType, unknown, Record<string, unknown>?]> = [
    ["text", 5],
    ["text", "x".repeat(10_001)],
    ["number", 3.5, { decimalPlaces: 0 }],
    ["number", 1.234, { decimalPlaces: 2 }],
    ["number", Number.NaN, { decimalPlaces: 0 }],
    ["number", Number.POSITIVE_INFINITY, { decimalPlaces: 0 }],
    ["number", "3", { decimalPlaces: 0 }],
    ["money", 10.37],
    ["money", "10"],
    ["money", 2 ** 60],
    ["date", "2026-02-31"],
    ["date", "2027-02-29"],
    ["date", "2026-2-3"],
    ["date", "2026-02-28T00:00:00Z"],
    ["datetime", "2026-10-01T12:01:00"],
    ["datetime", "2026-10-01T12:01:00+02:00"],
    ["datetime", "2026-13-01T12:01:00Z"],
    ["datetime", "2026-10-01T24:00:00Z"],
    ["time", "24:00"],
    ["time", "12:60"],
    ["time", "9:05"],
    ["boolean", 0],
    ["boolean", "true"],
    ["choice", ""],
    ["choice", 5],
  ];
  for (const [type, value, options] of GOOD) {
    it(`the default of a ${type} column may be ${JSON.stringify(value)}`, () => {
      expect(isValidDefault(type, normalizeTypeOptions(type, options ?? {}) ?? {}, value, 10_000)).toBe(true);
    });
  }
  for (const [type, value, options] of BAD) {
    it(`the default of a ${type} column may not be ${String(value)}`, () => {
      expect(isValidDefault(type, normalizeTypeOptions(type, options ?? {}) ?? {}, value, 10_000)).toBe(false);
    });
  }
  it("null is a default of every type", () => {
    for (const type of ["text", "number", "money", "date", "datetime", "time", "boolean", "choice"] as const) expect(isValidDefault(type, {}, null, 10)).toBe(true);
  });

  it("the limits are a dependency: 200 registries, 60 columns and 10 000 characters by default, other values when given", () => {
    expect(DEFAULT_REGISTRY_LIMITS).toEqual({ maxRegistries: 200, maxColumns: 60, textMaxChars: 10_000 });
    const column = (index: number) => ({ symbol: `c${index}`, displayName: `C${index}`, type: "text" });
    const many = (count: number): RegistryDraft => ({ symbol: "r", displayName: "R", columns: Array.from({ length: count }, (_, index) => column(index)) });
    expect(validateNewRegistry(many(60), context()).ok).toBe(true);
    expect(validateNewRegistry(many(61), context())).toEqual({ ok: false, issues: [{ path: "columns", code: "LIMIT_COLUMNS" }] });
    expect(validateNewRegistry(many(3), context({ limits: { ...DEFAULT_REGISTRY_LIMITS, maxColumns: 2 } }))).toEqual({ ok: false, issues: [{ path: "columns", code: "LIMIT_COLUMNS" }] });
    expect(validateNewRegistry(many(1), context({ activeRegistryCount: 199 })).ok).toBe(true);
    expect(validateNewRegistry(many(1), context({ activeRegistryCount: 200 }))).toEqual({ ok: false, issues: [{ path: "registry", code: "LIMIT_REGISTRIES" }] });
    const shortText: RegistryDraft = { symbol: "r", displayName: "R", columns: [{ symbol: "c", displayName: "C", type: "text", defaultValue: "abcdef" }] };
    expect(validateNewRegistry(shortText, context({ limits: { ...DEFAULT_REGISTRY_LIMITS, textMaxChars: 5 } }))).toEqual({ ok: false, issues: [{ path: "columns.0.defaultValue", code: "DEFAULT_INVALID" }] });
  });

  it("every issue is reported with the path of its field, and the symbol of a deleted registry stays taken", () => {
    const result = validateNewRegistry(
      {
        symbol: "Ksiazki",
        displayName: "  ",
        columns: [
          { symbol: "id", displayName: "Id", type: "text" },
          { symbol: "a", displayName: "A", type: "text" },
          { symbol: "a", displayName: "A again", type: "number", typeOptions: { decimalPlaces: 9 } },
          { symbol: "b", displayName: "B", type: "blob" },
          { symbol: "c", displayName: "C", type: "date", defaultValue: "2026-02-31", required: "yes" },
        ],
      },
      context(),
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: "symbol", code: "SYMBOL_PATTERN" },
        { path: "displayName", code: "NAME_EMPTY" },
        { path: "columns.0.symbol", code: "SYMBOL_RESERVED" },
        { path: "columns.2.symbol", code: "SYMBOL_TAKEN" },
        { path: "columns.2.typeOptions", code: "TYPE_OPTIONS_INVALID" },
        { path: "columns.3.type", code: "TYPE_UNKNOWN" },
        { path: "columns.4.required", code: "REQUIRED_FLAG_INVALID" },
        { path: "columns.4.defaultValue", code: "DEFAULT_INVALID" },
      ],
    });
    const taken = validateNewRegistry({ symbol: "ksiazki", displayName: "K", columns: [{ symbol: "t", displayName: "T", type: "text" }] }, context({ takenRegistrySymbols: new Set(["ksiazki"]) }));
    expect(taken).toEqual({ ok: false, issues: [{ path: "symbol", code: "SYMBOL_TAKEN" }] });
  });

  it("names are trimmed, limited to 80 characters and free of control characters; a registry needs a column", () => {
    const ok = validateNewRegistry({ symbol: "r", displayName: "  Książki  ", columns: [{ symbol: "c", displayName: " Tytuł ", type: "text" }] }, context());
    expect(ok.ok && [ok.value.displayName, ok.value.columns[0]?.displayName]).toEqual(["Książki", "Tytuł"]);
    for (const [name, code] of [["x".repeat(81), "NAME_TOO_LONG"], ["a\u0000b", "NAME_INVALID"], ["a\nb", "NAME_INVALID"], ["", "NAME_EMPTY"]] as const) {
      expect(validateNewRegistry({ symbol: "r", displayName: name, columns: [{ symbol: "c", displayName: "C", type: "text" }] }, context())).toEqual({ ok: false, issues: [{ path: "displayName", code }] });
    }
    expect(validateNewRegistry({ symbol: "r", displayName: "R", columns: [] }, context())).toEqual({ ok: false, issues: [{ path: "columns", code: "COLUMNS_MISSING" }] });
    expect(validateNewRegistry({ symbol: "r", displayName: "R", columns: "text" }, context())).toEqual({ ok: false, issues: [{ path: "columns", code: "COLUMNS_MISSING" }] });
  });

  it("hostile input of any shape is refused without throwing", () => {
    for (const draft of [{ symbol: null, displayName: null, columns: null }, { symbol: {}, displayName: [], columns: [null, 1, "x", [], {}] }, { symbol: "a", displayName: "A", columns: [{ symbol: "__proto__", displayName: "P", type: "text" }] }]) {
      const result = validateNewRegistry(draft as RegistryDraft, context());
      expect(result.ok).toBe(false);
    }
  });

  it("the rules are pure: the same input gives the same result and nothing is read from outside", () => {
    expect(validateNewRegistry(BOOKS(), context())).toEqual(validateNewRegistry(BOOKS(), context()));
    const source = readFileSync(path.join(repoRoot, "packages/core/src/modules/registries/domain/definition.ts"), "utf8") + readFileSync(path.join(repoRoot, "packages/core/src/modules/registries/domain/symbols.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|Date\.now|Math\.random|new Date\(\)/);
  });
});
