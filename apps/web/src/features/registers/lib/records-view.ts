// What the page of a registry shows of its records (Scope §5.6, DEV §9.19; D23.4): a search, a
// sort and a page, held in the address of the page so that a reload and "back" keep them. The
// address is the owner's to edit, so it is read as untrusted input: anything that is not a value of
// the view falls back to its default, and the server checks the rest (an unknown sort column).

/** The longest search, in code points after trimming: the rule of core/registries (`SEARCH_MAX_CODE_POINTS`), tested equal. */
export const SEARCH_MAX_CODE_POINTS = 100;
/** How long the search waits after the last key before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 300;

export type SortDirection = "asc" | "desc";
export type RecordsView = Readonly<{ search: string; sort: string; direction: SortDirection; page: number }>;

/** The newest records first: the order a registry opens in. */
export const DEFAULT_VIEW: RecordsView = { search: "", sort: "created_at", direction: "desc", page: 1 };

const SORT_SYMBOL = /^[a-z_][a-z0-9_]{0,99}$/;

/** The view an address holds; every part that is missing or not a value of its own is the default. */
export function parseRecordsView(raw: Readonly<Record<string, unknown>>): RecordsView {
  const search = typeof raw["search"] === "string" ? cutSearch(raw["search"]) : DEFAULT_VIEW.search;
  const sort = typeof raw["sort"] === "string" && SORT_SYMBOL.test(raw["sort"]) ? raw["sort"] : DEFAULT_VIEW.sort;
  const direction = raw["direction"] === "asc" || raw["direction"] === "desc" ? raw["direction"] : DEFAULT_VIEW.direction;
  const page = typeof raw["page"] === "number" && Number.isSafeInteger(raw["page"]) && raw["page"] >= 1 ? raw["page"] : DEFAULT_VIEW.page;
  return { search, sort, direction, page };
}

/** A search as long as the server takes it: an address with a longer one keeps its first 100 code points. */
export const cutSearch = (text: string): string => [...text].slice(0, SEARCH_MAX_CODE_POINTS).join("");

/** The address of a view: only what differs from the default, so a plain page has a plain address. */
export function viewSearch(view: RecordsView): Partial<RecordsView> {
  return {
    ...(view.search.trim() === "" ? {} : { search: view.search }),
    ...(view.sort === DEFAULT_VIEW.sort && view.direction === DEFAULT_VIEW.direction ? {} : { sort: view.sort, direction: view.direction }),
    ...(view.page === DEFAULT_VIEW.page ? {} : { page: view.page }),
  };
}

/** A new search or a new sort starts from the first page; a page keeps the rest. */
export const withSearch = (view: RecordsView, search: string): RecordsView => ({ ...view, search: cutSearch(search), page: 1 });
export const withSort = (view: RecordsView, sort: string, direction: SortDirection): RecordsView => ({ ...view, sort, direction, page: 1 });

export type SortOption = Readonly<{ value: string; sort: string; direction: SortDirection; column: string | null }>;

/** What "Sort" offers: the newest first, then every column ascending and descending (makieta 08). */
export function sortOptions(columns: readonly Readonly<{ symbol: string; displayName: string }>[]): SortOption[] {
  return [
    { value: `${DEFAULT_VIEW.sort}:${DEFAULT_VIEW.direction}`, sort: DEFAULT_VIEW.sort, direction: DEFAULT_VIEW.direction, column: null },
    ...columns.flatMap((column) => (["asc", "desc"] as const).map((direction) => ({ value: `${column.symbol}:${direction}`, sort: column.symbol, direction, column: column.displayName }))),
  ];
}

/** The first and the last position shown and the count, as "1–10 of 25"; null for no records. */
export function pageRange(page: number, pageSize: number, shown: number, total: number): Readonly<{ from: number; to: number; total: number }> | null {
  if (shown === 0 || total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  return { from, to: from + shown - 1, total };
}
