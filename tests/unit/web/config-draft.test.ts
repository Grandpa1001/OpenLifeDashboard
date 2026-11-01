// D25.3 — the draft of an entry of ConfigTable in the web app (Scope §5.7, makieta 23), as pure
// functions: the limits are the same as the rules of core, a value is sent exactly as typed, the
// live checks give the paths and codes the server gives, and an untouched form is no change.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_LIMITS, validateNewConfigEntry } from "../../../packages/core/dist/modules/configuration/public.js";
import { CONFIG_DESCRIPTION_MAX, CONFIG_VALUE_MAX, contentOf, draftOfEntry, EMPTY_ENTRY, entryProblems, isEntryChanged } from "../../../apps/web/src/features/registers/lib/config-draft.js";

const NORMA = { id: "019a0000-0000-7000-8000-00000000012c", symbol: "norma_czytania", displayName: "Norma czytania", value: "20", description: "Strony dziennie", revision: 1, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", bindings: 0 };
const draft = { ...EMPTY_ENTRY, displayName: "Norma czytania", symbol: "norma_czytania", symbolEdited: true, value: "20" };

describe("D25.3 the draft of an entry", () => {
  it("has the limits of core, and the live checks agree with the rules of core on the same drafts", () => {
    expect([CONFIG_VALUE_MAX, CONFIG_DESCRIPTION_MAX]).toEqual([DEFAULT_CONFIG_LIMITS.valueMaxCodePoints, DEFAULT_CONFIG_LIMITS.descriptionMaxCodePoints]);
    const cases = [
      draft,
      { ...draft, displayName: "  " },
      { ...draft, symbol: "Zły" },
      { ...draft, symbol: "a".repeat(41) },
      { ...draft, value: "ł".repeat(10_000) },
      { ...draft, value: "ł".repeat(10_001) },
      { ...draft, description: "😀".repeat(500) },
      { ...draft, description: "😀".repeat(501) },
      { ...draft, description: "z\ttabulatorem" },
      { ...draft, description: "dwie\nlinie" },
    ];
    for (const each of cases) {
      const core = validateNewConfigEntry({ symbol: each.symbol, ...contentOf(each) }, { limits: DEFAULT_CONFIG_LIMITS, takenSymbols: new Set(), count: 0 });
      const web = [...entryProblems(each, new Set())].map(([path, code]) => ({ path, code }));
      expect(web, JSON.stringify(each).slice(0, 80)).toEqual(core.ok ? [] : core.issues);
    }
  });

  it("sends the value and the description as typed and only the name trimmed; a stored entry's symbol is not checked again", () => {
    expect(contentOf({ ...draft, displayName: "  Norma ", value: " 20 \n", description: " opis " })).toEqual({ displayName: "Norma", value: " 20 \n", description: " opis " });
    expect(entryProblems({ ...draft, symbol: "norma_czytania" }, new Set(["norma_czytania"])).get("symbol")).toBe("SYMBOL_TAKEN");
    expect(entryProblems({ ...draft, symbol: "norma_czytania" }, null).size).toBe(0);
  });

  it("an untouched form is no change; a name typed back with spaces is none either; the value counts every space", () => {
    const stored = draftOfEntry(NORMA);
    expect(isEntryChanged(stored, NORMA)).toBe(false);
    expect(isEntryChanged({ ...stored, displayName: " Norma czytania " }, NORMA)).toBe(false);
    expect(isEntryChanged({ ...stored, value: "20 " }, NORMA)).toBe(true);
    expect(isEntryChanged({ ...stored, description: "" }, NORMA)).toBe(true);
  });
});
