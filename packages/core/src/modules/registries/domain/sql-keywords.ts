// Words that may not be the symbol of a column (Załącznik C): the keywords of SQLite
// (https://www.sqlite.org/lang_keywords.html) and the names the engine itself gives to a row. The
// DDL quotes every identifier anyway; the list keeps symbols readable in exports and queries.
const SQLITE_KEYWORDS = [
  "abort", "action", "add", "after", "all", "alter", "always", "analyze", "and", "as", "asc", "attach", "autoincrement", "before", "begin", "between", "by",
  "cascade", "case", "cast", "check", "collate", "column", "commit", "conflict", "constraint", "create", "cross", "current", "current_date", "current_time",
  "current_timestamp", "database", "default", "deferrable", "deferred", "delete", "desc", "detach", "distinct", "do", "drop", "each", "else", "end", "escape",
  "except", "exclude", "exclusive", "exists", "explain", "fail", "filter", "first", "following", "for", "foreign", "from", "full", "generated", "glob", "group",
  "groups", "having", "if", "ignore", "immediate", "in", "index", "indexed", "initially", "inner", "insert", "instead", "intersect", "into", "is", "isnull", "join",
  "key", "last", "left", "like", "limit", "match", "materialized", "natural", "no", "not", "nothing", "notnull", "null", "nulls", "of", "offset", "on", "or",
  "order", "others", "outer", "over", "partition", "plan", "pragma", "preceding", "primary", "query", "raise", "range", "recursive", "references", "regexp",
  "reindex", "release", "rename", "replace", "restrict", "returning", "right", "rollback", "row", "rows", "savepoint", "select", "set", "table", "temp",
  "temporary", "then", "ties", "to", "transaction", "trigger", "unbounded", "union", "unique", "update", "using", "vacuum", "values", "view", "virtual", "when",
  "where", "window", "with", "without",
] as const;

/** The columns every `reg_*` table has (Architektura §4.3) and the aliases SQLite gives the row. */
const ENGINE_COLUMNS = ["id", "user_id", "created_at", "updated_at", "revision", "rowid", "oid"] as const;

export const RESERVED_COLUMN_SYMBOLS: ReadonlySet<string> = new Set<string>([...ENGINE_COLUMNS, ...SQLITE_KEYWORDS]);
