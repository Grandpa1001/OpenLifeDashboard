// D16.2 — the symbol the form offers is the symbol core offers: the web app has its own
// implementation (it may not import core), and this table is what ties the two together.
import { suggestSymbol as coreSuggest } from "../../../packages/core/dist/modules/registries/public.js";
import { describe, expect, it } from "vitest";
import { suggestSymbol as webSuggest, SYMBOL_MAX_LENGTH, SYMBOL_PATTERN } from "../../../apps/web/src/features/registers/lib/suggest-symbol.js";

const NAMES = [
  "Książki",
  "Liczba stron",
  "Data ukończenia",
  "Zażółć gęślą jaźń",
  "  spaced   out  ",
  "Ponowne-czytanie",
  "a.b.c",
  "2024 plan",
  "123",
  "",
  "   ",
  "***",
  "Ünïcödé",
  "ŁÓDŹ",
  "x".repeat(60),
  `${"a".repeat(39)} b`,
  "a_b__c",
  "_leading",
  "trailing_",
  "Tytuł",
  "Waga (kg)",
  "emoji 📚 book",
  "tab\tseparated",
  "A/B testing",
  "pole",
  "id",
  "select",
  "revision",
];
const TAKEN: ReadonlyArray<ReadonlySet<string>> = [new Set(), new Set(["ksiazki"]), new Set(["ksiazki", "ksiazki_2", "ksiazki_3"]), new Set(["pole", "pole_2"]), new Set(["x".repeat(40)]), new Set(["a".repeat(39), `${"a".repeat(37)}_2`])];

describe("D16.2 the web suggestion equals core's", () => {
  it("every name, taken or not, gives the same symbol (the names core reserves for columns are not taken here, so they are compared as registries)", () => {
    for (const name of NAMES) {
      for (const taken of TAKEN) {
        expect(webSuggest(name, taken), JSON.stringify([name, [...taken]])).toBe(coreSuggest(name, "registry", taken));
      }
    }
  });

  it("what is offered always passes the pattern and the length", () => {
    for (const name of NAMES) {
      const symbol = webSuggest(name, new Set());
      expect(SYMBOL_PATTERN.test(symbol), JSON.stringify(name)).toBe(true);
      expect(symbol.length).toBeLessThanOrEqual(SYMBOL_MAX_LENGTH);
    }
  });

  it("the examples of the plan", () => {
    expect(webSuggest("Książki", new Set())).toBe("ksiazki");
    expect(webSuggest("Książki", new Set(["ksiazki"]))).toBe("ksiazki_2");
    expect(webSuggest("", new Set())).toBe("pole");
  });
});
