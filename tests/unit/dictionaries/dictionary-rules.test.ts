// D24.1 — the rules of a dictionary (Scope §5.8, Architektura §4.2, Załącznik C) on the dictionary
// of F01, and the rule of a "choice" column that names one. AC1: F01 is a valid dictionary with its
// order, hidden value and labels; a save is the whole list. AC2: every symbol, name, label and limit
// refused with its path; a column cannot name a dictionary the owner does not have.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_DICTIONARY_LIMITS, validateDictionaryContent, validateNewDictionary, valueChanges } from "../../../packages/core/dist/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS, validateNewRegistry } from "../../../packages/core/dist/modules/registries/public.js";
import { repoRoot } from "../../support/server-process.ts";

type FixtureDictionary = { id: string; symbol: string; displayName: string; values: Array<{ symbol: string; label: string; position: number; hidden: boolean }> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { dictionaries: FixtureDictionary[] };
const STATUS = fixture.dictionaries[0]!;
const draft = () => ({ symbol: STATUS.symbol, displayName: STATUS.displayName, values: STATUS.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })) });
const create = (input: unknown, over: Partial<{ takenSymbols: ReadonlySet<string>; count: number }> = {}) => validateNewDictionary(input, { limits: DEFAULT_DICTIONARY_LIMITS, takenSymbols: new Set(), count: 0, ...over });
const issuesOf = (result: { ok: boolean; issues?: readonly unknown[] }) => (result.ok ? [] : result.issues);

describe("D24.1-AC1 the dictionary of F01", () => {
  it("is valid as it stands: its symbol, name and four values in their order, the archived one hidden", () => {
    const result = create(draft());
    expect(result).toEqual({ ok: true, value: draft() });
    expect(STATUS.values.map((value) => value.position)).toEqual([0, 1, 2, 3]);
    if (result.ok) expect(result.value.values.filter((value) => value.hidden).map((value) => value.label)).toEqual(["Archiwalne"]);
  });

  it("names and labels are trimmed, a value without `hidden` is shown, and an empty list is a dictionary", () => {
    expect(create({ symbol: "kraje", displayName: "  Kraje ", values: [{ symbol: "pl", label: " Polska " }] })).toEqual({ ok: true, value: { symbol: "kraje", displayName: "Kraje", values: [{ symbol: "pl", label: "Polska", hidden: false }] } });
    expect(create({ symbol: "puste", displayName: "Puste" })).toEqual({ ok: true, value: { symbol: "puste", displayName: "Puste", values: [] } });
  });

  it("a save is the whole list in its new order, with labels and hidden changed; the audit sees the symbols that came and went", () => {
    const reordered = { displayName: "Status", values: [{ symbol: "ukonczone", label: "Przeczytana", hidden: false }, { symbol: "planowane", label: "W planie", hidden: true }, { symbol: "nowa", label: "Nowa", hidden: false }] };
    expect(validateDictionaryContent(reordered, DEFAULT_DICTIONARY_LIMITS)).toEqual({ ok: true, value: reordered });
    expect(valueChanges(STATUS.values, reordered.values)).toEqual({ added: ["nowa"], removed: ["czytane", "archiwalne"] });
  });
});

describe("D24.1-AC2 what the rules refuse", () => {
  it("a symbol that is no symbol, too long or taken; a name that is empty, too long or has a control character", () => {
    expect(issuesOf(create({ ...draft(), symbol: "Status" }))).toEqual([{ path: "symbol", code: "SYMBOL_PATTERN" }]);
    expect(issuesOf(create({ ...draft(), symbol: "a".repeat(41) }))).toEqual([{ path: "symbol", code: "SYMBOL_TOO_LONG" }]);
    expect(issuesOf(create(draft(), { takenSymbols: new Set([STATUS.symbol]) }))).toEqual([{ path: "symbol", code: "SYMBOL_TAKEN" }]);
    expect(issuesOf(create({ ...draft(), displayName: "   " }))).toEqual([{ path: "displayName", code: "NAME_EMPTY" }]);
    expect(issuesOf(create({ ...draft(), displayName: "x".repeat(81) }))).toEqual([{ path: "displayName", code: "NAME_TOO_LONG" }]);
    expect(issuesOf(create({ ...draft(), displayName: "a\u0007b" }))).toEqual([{ path: "displayName", code: "NAME_INVALID" }]);
    expect(issuesOf(create(null))).toEqual([{ path: "symbol", code: "SYMBOL_PATTERN" }, { path: "displayName", code: "NAME_EMPTY" }]);
  });

  it("every value with its path: a bad or repeated symbol, an empty label, a hidden that is no boolean, a value that is no object", () => {
    const values = [{ symbol: "pl", label: "Polska" }, { symbol: "pl", label: "Druga" }, { symbol: "DE", label: "Niemcy" }, { symbol: "cz", label: " " }, { symbol: "sk", label: "Słowacja", hidden: "yes" }, "fr"];
    expect(issuesOf(create({ symbol: "kraje", displayName: "Kraje", values }))).toEqual([
      { path: "values.1.symbol", code: "SYMBOL_TAKEN" },
      { path: "values.2.symbol", code: "SYMBOL_PATTERN" },
      { path: "values.3.label", code: "NAME_EMPTY" },
      { path: "values.4.hidden", code: "HIDDEN_INVALID" },
      { path: "values.5", code: "VALUE_NOT_OBJECT" },
    ]);
    expect(issuesOf(validateDictionaryContent({ displayName: "Kraje", values: "pl" }, DEFAULT_DICTIONARY_LIMITS))).toEqual([{ path: "values", code: "VALUES_NOT_LIST" }]);
  });

  it("the limits of 200 dictionaries and 500 values, on their edge", () => {
    expect(DEFAULT_DICTIONARY_LIMITS).toEqual({ maxDictionaries: 200, maxValues: 500 });
    expect(create(draft(), { count: 199 }).ok).toBe(true);
    expect(issuesOf(create(draft(), { count: 200 }))).toEqual([{ path: "dictionary", code: "LIMIT_DICTIONARIES" }]);
    const many = (n: number) => Array.from({ length: n }, (_, index) => ({ symbol: `v${index}`, label: `V${index}` }));
    expect(validateDictionaryContent({ displayName: "D", values: many(500) }, DEFAULT_DICTIONARY_LIMITS).ok).toBe(true);
    expect(issuesOf(validateDictionaryContent({ displayName: "D", values: many(501) }, DEFAULT_DICTIONARY_LIMITS))).toEqual([{ path: "values", code: "LIMIT_VALUES" }]);
  });

  it("a choice column may name only a dictionary of the owner; without one it is plain text", () => {
    const registry = (dictionaryId?: string) => ({ symbol: "ksiazki", displayName: "Książki", columns: [{ symbol: "status", displayName: "Status", type: "choice", typeOptions: dictionaryId === undefined ? {} : { dictionaryId } }] });
    const context = { limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: new Set<string>(), activeRegistryCount: 0, dictionaryIds: new Set([STATUS.id]) };
    expect(validateNewRegistry(registry(STATUS.id), context).ok).toBe(true);
    expect(validateNewRegistry(registry(), context).ok).toBe(true);
    expect(issuesOf(validateNewRegistry(registry("019a0000-0000-7000-8000-00000000ffff"), context))).toEqual([{ path: "columns.0.typeOptions.dictionaryId", code: "DICTIONARY_UNKNOWN" }]);
  });
});
