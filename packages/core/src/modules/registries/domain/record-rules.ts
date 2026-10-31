// The rules of one record of a registry (Architektura §4.5, §4.6, §18.1): which values may be
// stored, in the canonical form of the API, and what the sort of a list may name. Everything here
// is decided from the schema of the registry as the catalog holds it, without a database, a clock
// or a source of randomness. Converting what a person typed into a canonical value is D22's.
import { utf8Length } from "../../../foundation/public.js";
import { isValidCellValue, type CellValue, type ColumnType, type ColumnTypeOptions } from "./column-rules.js";

export type RecordColumn = Readonly<{ symbol: string; type: ColumnType; typeOptions: ColumnTypeOptions; defaultValue: CellValue; required: boolean }>;
export type RecordSchema = Readonly<{ schemaRevision: number; columns: readonly RecordColumn[] }>;

/** Limits of a record, given by the caller (they come from the option catalog, `limits.recordMaxKiB`). */
export type RecordPolicy = Readonly<{ maxTextCodePoints: number; maxRecordBytes: number }>;

export type RecordIssueCode = "VALUES_NOT_OBJECT" | "VALUES_EMPTY" | "FIELD_SYSTEM" | "FIELD_UNKNOWN" | "VALUE_INVALID" | "VALUE_REQUIRED" | "RECORD_TOO_LARGE";
export type RecordIssue = Readonly<{ path: string; code: RecordIssueCode }>;
export type RecordValuesResult = Readonly<{ ok: true; values: Readonly<Record<string, CellValue>> }> | Readonly<{ ok: false; issues: readonly RecordIssue[] }>;

/** The columns every record has besides the owner's own; a client never supplies them. */
export const SYSTEM_RECORD_FIELDS: ReadonlySet<string> = new Set(["id", "user_id", "created_at", "updated_at", "revision"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const BLANK = /^\s*$/u;

const textual = (type: ColumnType): boolean => type === "text" || type === "choice";

/** Every key of the input that is not a column of the schema: a system field or an unknown one, refused rather than ignored. */
function foreignFields(schema: RecordSchema, input: Readonly<Record<string, unknown>>): RecordIssue[] {
  const known = new Set(schema.columns.map((column) => column.symbol));
  return Object.keys(input)
    .filter((key) => !known.has(key))
    .map((key) => ({ path: `values.${key}`, code: SYSTEM_RECORD_FIELDS.has(key) ? "FIELD_SYSTEM" : "FIELD_UNKNOWN" }));
}

/**
 * The value of every column checked by its type and its required flag, and the record by its size.
 * `maxTextCodePointsOf` gives the text limit of a column, so a value kept from the stored record may
 * be longer than the limit is today (Architektura §4.6).
 */
function checkColumns(schema: RecordSchema, valueOf: (column: RecordColumn) => unknown, maxTextCodePointsOf: (column: RecordColumn) => number, policy: RecordPolicy, issues: RecordIssue[]): RecordValuesResult {
  const values: Record<string, CellValue> = {};
  for (const column of schema.columns) {
    const path = `values.${column.symbol}`;
    const value = valueOf(column);
    if (!isValidCellValue(column.type, column.typeOptions, value, maxTextCodePointsOf(column))) {
      issues.push({ path, code: "VALUE_INVALID" });
      continue;
    }
    if (column.required && (value === null || (textual(column.type) && typeof value === "string" && BLANK.test(value)))) {
      issues.push({ path, code: "VALUE_REQUIRED" });
      continue;
    }
    values[column.symbol] = value;
  }

  if (issues.length === 0 && utf8Length(JSON.stringify(values)) > policy.maxRecordBytes) {
    issues.push({ path: "values", code: "RECORD_TOO_LARGE" });
  }
  return issues.length === 0 ? { ok: true, values } : { ok: false, issues };
}

/**
 * The values of a new record. Every key must be a column of the schema (an unknown or a system
 * field is refused, not ignored). A column left out takes its default from the catalog; a column
 * given as `null` stays `null`. A required column has a value: not null, and for text not empty and
 * not only white space. Every problem is returned, each with the path of its field.
 */
export function validateRecordValues(schema: RecordSchema, input: unknown, policy: RecordPolicy): RecordValuesResult {
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: "values", code: "VALUES_NOT_OBJECT" }] };
  return checkColumns(
    schema,
    (column) => (Object.hasOwn(input, column.symbol) ? input[column.symbol] : column.defaultValue),
    () => policy.maxTextCodePoints,
    policy,
    foreignFields(schema, input),
  );
}

/**
 * The values of a stored record after a change (Architektura §4.6, §18.2): the change names only
 * the columns it changes, and the record is checked whole after they are joined. A column the
 * change leaves out keeps its stored value (a column the record has no value for is `null`); that
 * value is checked by its type but not by the text limit, so lowering the limit never makes an
 * untouched record impossible to edit. A new value meets the limit of today. A change with no
 * column is refused: it would raise the revision and change nothing.
 */
export function validateRecordChanges(schema: RecordSchema, stored: Readonly<Record<string, CellValue>>, changes: unknown, policy: RecordPolicy): RecordValuesResult {
  if (!isPlainObject(changes)) return { ok: false, issues: [{ path: "values", code: "VALUES_NOT_OBJECT" }] };
  if (Object.keys(changes).length === 0) return { ok: false, issues: [{ path: "values", code: "VALUES_EMPTY" }] };
  const changed = (column: RecordColumn): boolean => Object.hasOwn(changes, column.symbol);
  return checkColumns(
    schema,
    (column) => (changed(column) ? changes[column.symbol] : (stored[column.symbol] ?? null)),
    (column) => (changed(column) ? policy.maxTextCodePoints : Number.POSITIVE_INFINITY),
    policy,
    foreignFields(schema, changes),
  );
}

/** JSON with the keys of every object in order, so the same input always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The text an idempotency key is bound to: the revision of the form and the values as sent, in canonical form. */
export const canonicalRecordRequest = (schemaRevision: number, values: unknown): string => canonicalJson({ schemaRevision, values });

export type SortColumn = Readonly<{ kind: "system"; symbol: "created_at" | "updated_at" | "id" }> | Readonly<{ kind: "column"; symbol: string }>;
export type SortDirection = "asc" | "desc";
const SYSTEM_SORTS: ReadonlySet<string> = new Set(["created_at", "updated_at", "id"]);

/** What a list may be sorted by: a system column or a column of the registry. Anything else is null, never passed on. */
export function resolveSortColumn(columns: readonly Readonly<{ symbol: string }>[], requested: string): SortColumn | null {
  if (SYSTEM_SORTS.has(requested)) return { kind: "system", symbol: requested as "created_at" | "updated_at" | "id" };
  return columns.some((column) => column.symbol === requested) ? { kind: "column", symbol: requested } : null;
}

export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 100;
