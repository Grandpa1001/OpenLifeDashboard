// The definition of a new registry (Architektura §4.3, §5.1): everything that can be decided
// without the database. The input is untrusted — the transport has checked its shape, but this
// rule does not rely on it — and the result is either a normalized definition or every issue found,
// each with the path of the field, so a form can show them all at once.
import { isColumnType, isValidDefault, normalizeTypeOptions, type CellValue, type ColumnType, type ColumnTypeOptions } from "./column-rules.js";
import { DISPLAY_NAME_MAX_CHARS, type RegistryLimits } from "./limits.js";
import { checkSymbol, type SymbolIssue } from "./symbols.js";

export type RegistryIssueCode =
  | SymbolIssue
  | "NAME_EMPTY"
  | "NAME_TOO_LONG"
  | "NAME_INVALID"
  | "TYPE_UNKNOWN"
  | "TYPE_OPTIONS_INVALID"
  | "DICTIONARY_UNKNOWN"
  | "DEFAULT_INVALID"
  | "REQUIRED_FLAG_INVALID"
  | "COLUMNS_MISSING"
  | "LIMIT_COLUMNS"
  | "LIMIT_REGISTRIES";

export type RegistryIssue = Readonly<{ path: string; code: RegistryIssueCode }>;

export type ColumnDraft = Readonly<{ symbol: unknown; displayName: unknown; type: unknown; typeOptions?: unknown; defaultValue?: unknown; required?: unknown }>;
export type RegistryDraft = Readonly<{ symbol: unknown; displayName: unknown; columns: unknown }>;

export type NewColumn = Readonly<{
  symbol: string;
  displayName: string;
  type: ColumnType;
  typeOptions: ColumnTypeOptions;
  defaultValue: CellValue;
  required: boolean;
  /** Order in the registry, from 0. */
  position: number;
}>;
export type NewRegistry = Readonly<{ symbol: string; displayName: string; columns: readonly NewColumn[] }>;

export type RegistryContext = Readonly<{
  limits: RegistryLimits;
  /** Symbols of every registry the installation has had, deleted ones included (the symbol stays reserved). */
  takenRegistrySymbols: ReadonlySet<string>;
  /** Registries that are not deleted. */
  activeRegistryCount: number;
  /** The dictionaries of the owner a "choice" column may name (D24.1); records are never checked against them. */
  dictionaryIds: ReadonlySet<string>;
}>;

export type DefinitionResult = Readonly<{ ok: true; value: NewRegistry }> | Readonly<{ ok: false; issues: readonly RegistryIssue[] }>;

// eslint-disable-next-line no-control-regex -- a control character in a name is exactly what is refused.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type DisplayNameIssue = "NAME_EMPTY" | "NAME_TOO_LONG" | "NAME_INVALID";

/**
 * The rule of every display name and label of the catalogs (Architektura Załącznik C): 1–80
 * characters after trimming, no control characters. The trimmed name, or why it cannot be one.
 */
export function checkDisplayName(value: unknown): Readonly<{ ok: true; name: string }> | Readonly<{ ok: false; issue: DisplayNameIssue }> {
  if (typeof value !== "string") return { ok: false, issue: "NAME_EMPTY" };
  const name = value.trim();
  if (name === "") return { ok: false, issue: "NAME_EMPTY" };
  if (Array.from(name).length > DISPLAY_NAME_MAX_CHARS) return { ok: false, issue: "NAME_TOO_LONG" };
  if (CONTROL_CHARACTERS.test(name)) return { ok: false, issue: "NAME_INVALID" };
  return { ok: true, name };
}

function nameOf(value: unknown, path: string, issues: RegistryIssue[]): string | null {
  const checked = checkDisplayName(value);
  if (checked.ok) return checked.name;
  issues.push({ path, code: checked.issue });
  return null;
}

function symbolOf(value: unknown, space: "registry" | "column", taken: ReadonlySet<string>, path: string, issues: RegistryIssue[]): string | null {
  const issue = typeof value === "string" ? checkSymbol(value, space, taken) : "SYMBOL_PATTERN";
  if (issue !== null) {
    issues.push({ path, code: issue });
    return null;
  }
  return value as string;
}

/** Validates the definition of a registry that does not exist yet; a column may be required without a default. */
export function validateNewRegistry(draft: RegistryDraft, context: RegistryContext): DefinitionResult {
  const issues: RegistryIssue[] = [];
  if (context.activeRegistryCount >= context.limits.maxRegistries) issues.push({ path: "registry", code: "LIMIT_REGISTRIES" });

  const symbol = symbolOf(draft.symbol, "registry", context.takenRegistrySymbols, "symbol", issues);
  const displayName = nameOf(draft.displayName, "displayName", issues);

  const columnDrafts: readonly unknown[] = Array.isArray(draft.columns) ? draft.columns : [];
  if (columnDrafts.length === 0) issues.push({ path: "columns", code: "COLUMNS_MISSING" });
  if (columnDrafts.length > context.limits.maxColumns) issues.push({ path: "columns", code: "LIMIT_COLUMNS" });

  const columns: NewColumn[] = [];
  const takenColumnSymbols = new Set<string>();
  columnDrafts.slice(0, context.limits.maxColumns).forEach((entry, position) => {
    const at = `columns.${position}`;
    const column = (typeof entry === "object" && entry !== null ? entry : {}) as ColumnDraft;
    const columnSymbol = symbolOf(column.symbol, "column", takenColumnSymbols, `${at}.symbol`, issues);
    if (typeof column.symbol === "string") takenColumnSymbols.add(column.symbol);
    const columnName = nameOf(column.displayName, `${at}.displayName`, issues);

    let type: ColumnType | null = null;
    if (isColumnType(column.type)) type = column.type;
    else issues.push({ path: `${at}.type`, code: "TYPE_UNKNOWN" });

    const options = type === null ? null : normalizeTypeOptions(type, column.typeOptions ?? {});
    if (type !== null && options === null) issues.push({ path: `${at}.typeOptions`, code: "TYPE_OPTIONS_INVALID" });
    const unknownDictionary = options?.dictionaryId !== undefined && !context.dictionaryIds.has(options.dictionaryId);
    if (unknownDictionary) issues.push({ path: `${at}.typeOptions.dictionaryId`, code: "DICTIONARY_UNKNOWN" });

    const required = column.required ?? false;
    if (typeof required !== "boolean") issues.push({ path: `${at}.required`, code: "REQUIRED_FLAG_INVALID" });

    const defaultValue = column.defaultValue ?? null;
    if (type !== null && options !== null && !isValidDefault(type, options, defaultValue, context.limits.textMaxChars)) issues.push({ path: `${at}.defaultValue`, code: "DEFAULT_INVALID" });

    if (columnSymbol !== null && columnName !== null && type !== null && options !== null && !unknownDictionary && typeof required === "boolean" && isValidDefault(type, options, defaultValue, context.limits.textMaxChars)) {
      columns.push({ symbol: columnSymbol, displayName: columnName, type, typeOptions: options, defaultValue, required, position });
    }
  });

  if (issues.length > 0 || symbol === null || displayName === null) return { ok: false, issues };
  return { ok: true, value: { symbol, displayName, columns } };
}
