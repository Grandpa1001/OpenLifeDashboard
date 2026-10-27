// The page of the table of records (Scope §6.2): the size is fixed here until the widget and the
// module make it a setting (D34); the server limits it to 1–100.
export const RECORDS_PAGE_SIZE = 10;

/** The number of pages for `total` records; an empty registry has one (empty) page. */
export const pageCount = (total: number, pageSize: number): number => Math.max(1, Math.ceil(total / pageSize));
