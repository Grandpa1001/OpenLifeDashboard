// Bounds of the parser of the export format (Architektura Załącznik G; D45.1): protocol values, not options.

/** Issues the parser lists at most; a file with more is rejected all the same, with the first of them. */
export const EXPORT_ISSUES_MAX = 100;

/** Records the export reads and writes at a time: one short read of the database, then the event loop is given back. */
export const EXPORT_RECORDS_PER_PAGE = 500;
