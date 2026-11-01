// D24.3 — the editor of a dictionary and the labels of a page (makieta 22, §9.20), as pure
// functions: a move keeps the other values in their order, a new value gets a free symbol from its
// label while a stored one keeps its own, the request is the whole list in order, the field of a
// record offers the visible values and keeps a hidden or unknown current one, and a label is read
// only for a symbol the page names.
import { describe, expect, it } from "vitest";
import type { DictionaryDto } from "@openlife/contracts/http/dictionaries";
import { choiceOptions, draftOf, draftProblems, isChanged, moved, requestOf, withLabel, withNewValue } from "../../../apps/web/src/features/registers/lib/dictionary-draft.js";
import { valueLabel } from "../../../apps/web/src/lib/format/value-label.js";

const STATUS: DictionaryDto = {
  id: "0190a6d2-0000-7000-8000-000000000001",
  symbol: "status_czytania",
  displayName: "Status czytania",
  revision: 3,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  values: [
    { symbol: "planowane", label: "Planowane", hidden: false },
    { symbol: "w_trakcie", label: "W trakcie", hidden: false },
    { symbol: "ukonczone", label: "Ukończone", hidden: false },
    { symbol: "archiwalne", label: "Archiwalne", hidden: true },
  ],
  usages: [],
};
const symbols = (values: readonly { symbol: string }[]) => values.map((value) => value.symbol);

describe("D24.3 the order of the values", () => {
  it("a move takes one value to its new place and keeps the others in order; past an end it stays at the end", () => {
    const values = draftOf(STATUS).values;
    expect(symbols(moved(values, 0, 2))).toEqual(["w_trakcie", "ukonczone", "planowane", "archiwalne"]);
    expect(symbols(moved(values, 3, 0))).toEqual(["archiwalne", "planowane", "w_trakcie", "ukonczone"]);
    expect(symbols(moved(values, 3, 9))).toEqual(symbols(values));
    expect(moved(values, 0, -1)).toBe(values);
    // The request is the list in the order of the rows, on the revision the editor was built on.
    const request = requestOf({ ...draftOf(STATUS), values: moved(values, 0, 2) }, STATUS.revision);
    expect(request.expectedRevision).toBe(3);
    expect(symbols(request.values)).toEqual(["w_trakcie", "ukonczone", "planowane", "archiwalne"]);
    expect(request.values[3]).toEqual({ symbol: "archiwalne", label: "Archiwalne", hidden: true });
  });

  it("an untouched draft is no change; a label typed back as it was is none either", () => {
    const draft = draftOf(STATUS);
    expect(isChanged(draft, STATUS)).toBe(false);
    expect(isChanged(withLabel(draft, 0, "Planowane "), STATUS)).toBe(false);
    expect(isChanged(withLabel(draft, 0, "W planie"), STATUS)).toBe(true);
    expect(isChanged({ ...draft, values: moved(draft.values, 1, 0) }, STATUS)).toBe(true);
  });
});

describe("D24.3 symbols and the live checks", () => {
  it("a new value gets a free symbol from its label; a stored value keeps its symbol whatever its label", () => {
    let draft = withNewValue(draftOf(STATUS));
    expect(draft.values[4]).toMatchObject({ symbol: "", stored: false });
    expect(new Set(draft.values.map((value) => value.key)).size).toBe(5);
    draft = withLabel(draft, 4, "Planowane");
    expect(draft.values[4]!.symbol).toBe("planowane_2");
    draft = withLabel(draft, 0, "W planie");
    expect(draft.values[0]).toMatchObject({ symbol: "planowane", label: "W planie" });
  });

  it("an empty name or label, a bad symbol and a repeated symbol are told with the server's paths", () => {
    const draft = withNewValue({ ...draftOf(STATUS), displayName: "  " });
    const problems = draftProblems({ ...draft, values: [...draft.values.slice(0, 4), { ...draft.values[4]!, symbol: "planowane", label: "" }, { ...draft.values[4]!, key: 9, symbol: "Zła", label: "Zła" }] });
    expect(Object.fromEntries(problems)).toEqual({ displayName: "NAME_EMPTY", "values.4.label": "NAME_EMPTY", "values.4.symbol": "SYMBOL_TAKEN", "values.5.symbol": "SYMBOL_PATTERN" });
    expect(draftProblems(draftOf(STATUS)).size).toBe(0);
  });
});

describe("D24.3 the field of a record with a dictionary", () => {
  it("offers the visible values in the order of the dictionary; a hidden or unknown current value stays an option", () => {
    const visible = [
      { value: "planowane", label: "Planowane" },
      { value: "w_trakcie", label: "W trakcie" },
      { value: "ukonczone", label: "Ukończone" },
    ];
    expect(choiceOptions(STATUS.values, "")).toEqual(visible);
    expect(choiceOptions(STATUS.values, "w_trakcie")).toEqual(visible);
    expect(choiceOptions(STATUS.values, "archiwalne")).toEqual([...visible, { value: "archiwalne", label: "Archiwalne" }]);
    expect(choiceOptions(STATUS.values, "spoza_slownika")).toEqual([...visible, { value: "spoza_slownika", label: "spoza_slownika" }]);
  });

  it("a label is read only for a column and a symbol the page names, as an own key", () => {
    const labels = { status: { planowane: "Planowane", archiwalne: "Archiwalne" } };
    expect(valueLabel(labels, "status", "archiwalne")).toBe("Archiwalne");
    expect(valueLabel(labels, "status", "spoza_slownika")).toBeNull();
    expect(valueLabel(labels, "tytul", "planowane")).toBeNull();
    expect(valueLabel(labels, "status", null)).toBeNull();
    expect(valueLabel(labels, "status", "constructor")).toBeNull();
    expect(valueLabel(labels, "constructor", "planowane")).toBeNull();
  });
});
