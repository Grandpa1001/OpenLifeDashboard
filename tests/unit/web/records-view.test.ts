// D23.4 — the view of the records in the address (DEV §9.19): read as untrusted input with every
// part falling back to its default, written back with only what differs, a new search or sort on the
// first page, the options of "Sort" and the range of the pager. The limit of a search is core's.
import { describe, expect, it } from "vitest";
import { SEARCH_MAX_CODE_POINTS as CORE_SEARCH_MAX } from "../../../packages/core/dist/modules/registries/public.js";
import { cutSearch, DEFAULT_VIEW, pageRange, parseRecordsView, SEARCH_DEBOUNCE_MS, SEARCH_MAX_CODE_POINTS, sortOptions, viewSearch, withSearch, withSort } from "../../../apps/web/src/features/registers/lib/records-view.js";

describe("D23.4 the view in the address", () => {
  it("an address with nothing, or with values that are no values of the view, is the default view", () => {
    expect(parseRecordsView({})).toEqual(DEFAULT_VIEW);
    expect(parseRecordsView({ search: 5, sort: "tytul; DROP", direction: "sideways", page: 0 })).toEqual(DEFAULT_VIEW);
    expect(parseRecordsView({ page: 2.5 })).toEqual(DEFAULT_VIEW);
    expect(parseRecordsView({ page: -3 })).toEqual(DEFAULT_VIEW);
    expect(parseRecordsView({ search: "Diuna", sort: "tytul", direction: "asc", page: 3 })).toEqual({ search: "Diuna", sort: "tytul", direction: "asc", page: 3 });
  });

  it("a search longer than the server takes keeps its first 100 code points, the same limit as core", () => {
    expect(SEARCH_MAX_CODE_POINTS).toBe(CORE_SEARCH_MAX);
    expect(cutSearch("ł".repeat(150))).toBe("ł".repeat(100));
    expect([...parseRecordsView({ search: "𝔸".repeat(101) }).search]).toHaveLength(100);
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });

  it("the address holds only what differs from the default, and reads back as the same view", () => {
    expect(viewSearch(DEFAULT_VIEW)).toEqual({});
    expect(viewSearch({ ...DEFAULT_VIEW, search: "   " })).toEqual({});
    const view = { search: "testowa", sort: "tytul", direction: "asc", page: 2 } as const;
    expect(viewSearch(view)).toEqual(view);
    expect(parseRecordsView(viewSearch(view))).toEqual(view);
    expect(viewSearch({ ...DEFAULT_VIEW, direction: "asc" })).toEqual({ sort: "created_at", direction: "asc" });
  });

  it("a new search or a new sort starts from the first page", () => {
    const deep = { search: "a", sort: "tytul", direction: "asc", page: 3 } as const;
    expect(withSearch(deep, "b")).toEqual({ ...deep, search: "b", page: 1 });
    expect(withSort(deep, "autor", "desc")).toEqual({ search: "a", sort: "autor", direction: "desc", page: 1 });
  });
});

describe("D23.4 what Sort offers and what the pager says", () => {
  it("the newest first, then every column ascending and descending", () => {
    expect(sortOptions([{ symbol: "tytul", displayName: "Tytuł" }, { symbol: "strony", displayName: "Strony" }]).map((option) => [option.value, option.column])).toEqual([
      ["created_at:desc", null],
      ["tytul:asc", "Tytuł"],
      ["tytul:desc", "Tytuł"],
      ["strony:asc", "Strony"],
      ["strony:desc", "Strony"],
    ]);
  });

  it("the range is the first and last position of the page and the count", () => {
    expect(pageRange(1, 10, 10, 25)).toEqual({ from: 1, to: 10, total: 25 });
    expect(pageRange(3, 10, 5, 25)).toEqual({ from: 21, to: 25, total: 25 });
    expect(pageRange(1, 10, 4, 4)).toEqual({ from: 1, to: 4, total: 4 });
    expect(pageRange(1, 10, 0, 0)).toBeNull();
  });
});
