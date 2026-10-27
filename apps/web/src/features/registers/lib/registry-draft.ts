// The draft of a new registry while the form is open: what the owner typed, the live checks that
// need no server, and the request that is sent. The rules of the catalog are the server's; these
// checks only save a round trip for what is plainly wrong (pattern, length, a repeated symbol).
import type { CreateRegistryRequest } from "@openlife/contracts/http/registries";
import { suggestSymbol, SYMBOL_MAX_LENGTH, SYMBOL_PATTERN } from "./suggest-symbol.js";

export const COLUMN_TYPES = ["text", "number", "money", "date", "datetime", "time", "boolean", "choice"] as const;
export type ColumnTypeCode = (typeof COLUMN_TYPES)[number];

/** The most decimal places a number may have (Architektura §4.3). */
export const DECIMAL_PLACES_MAX = 6;

/** Types whose default value the form can write in the canonical form of the API without a conversion. */
export const TYPES_WITH_DEFAULT: ReadonlySet<ColumnTypeCode> = new Set<ColumnTypeCode>(["text", "number", "date", "time", "boolean", "choice"]);

export type ColumnDraft = Readonly<{
  /** Identity of the row in the form, not of the column. */
  key: number;
  displayName: string;
  symbol: string;
  /** True once the owner typed the symbol: it no longer follows the name. */
  symbolEdited: boolean;
  type: ColumnTypeCode;
  decimalPlaces: number;
  required: boolean;
  /** What was typed; for a boolean "", "true" or "false". */
  defaultValue: string;
}>;

export type RegistryDraft = Readonly<{ displayName: string; symbol: string; symbolEdited: boolean; columns: readonly ColumnDraft[] }>;

export const emptyColumn = (key: number): ColumnDraft => ({ key, displayName: "", symbol: "", symbolEdited: false, type: "text", decimalPlaces: 0, required: false, defaultValue: "" });

/** The path an issue of the server or of the live check names, as the server writes it. */
export type FieldPath = string;
export type FieldProblem = "NAME_EMPTY" | "SYMBOL_EMPTY" | "SYMBOL_PATTERN" | "SYMBOL_TOO_LONG" | "SYMBOL_TAKEN" | "DEFAULT_INVALID" | "COLUMNS_MISSING";

/** The fields of a column the server names in its issues. */
export const COLUMN_FIELD = { name: "displayName", symbol: "symbol", type: "type", options: "typeOptions", default: "defaultValue", required: "required" } as const;
export type ColumnField = (typeof COLUMN_FIELD)[keyof typeof COLUMN_FIELD];
export const columnPath = (index: number, field: ColumnField): FieldPath => `columns.${index}.${field}`;
/** The paths of the fields of the column at `index`, by name. */
export const columnPaths = (index: number) => ({
  name: columnPath(index, COLUMN_FIELD.name),
  symbol: columnPath(index, COLUMN_FIELD.symbol),
  type: columnPath(index, COLUMN_FIELD.type),
  options: columnPath(index, COLUMN_FIELD.options),
  default: columnPath(index, COLUMN_FIELD.default),
});

/** The paths of the fields of the registry itself. */
export const REGISTRY_PATH = { name: "displayName", symbol: "symbol", columns: "columns", registry: "registry" } as const;

/** The two values of a yes/no default as they are typed in the select. */
export const BOOLEAN_CHOICE = { yes: "true", no: "false" } as const;

/** The default of a column as the API takes it, or `undefined` for none, or `invalid` when what was typed is no value of the type. */
export function defaultOf(column: ColumnDraft): string | number | boolean | undefined | "invalid" {
  const typed = column.defaultValue;
  if (!TYPES_WITH_DEFAULT.has(column.type) || typed === "") return undefined;
  if (column.type === "boolean") return typed === BOOLEAN_CHOICE.yes ? true : typed === BOOLEAN_CHOICE.no ? false : "invalid";
  if (column.type === "number") {
    const value = Number(typed.trim().replace(",", "."));
    return typed.trim() !== "" && Number.isFinite(value) ? value : "invalid";
  }
  return typed;
}

/** With the name typed, the symbol follows it until the owner types a symbol of their own. */
export function withSuggestedSymbol<T extends { displayName: string; symbol: string; symbolEdited: boolean }>(draft: T, taken: ReadonlySet<string>): T {
  return draft.symbolEdited || draft.displayName.trim() === "" ? { ...draft, symbol: draft.symbolEdited ? draft.symbol : "" } : { ...draft, symbol: suggestSymbol(draft.displayName, taken) };
}

function symbolProblem(symbol: string, taken: ReadonlySet<string>): FieldProblem | null {
  if (symbol === "") return "SYMBOL_EMPTY";
  if (!SYMBOL_PATTERN.test(symbol)) return "SYMBOL_PATTERN";
  if (symbol.length > SYMBOL_MAX_LENGTH) return "SYMBOL_TOO_LONG";
  if (taken.has(symbol)) return "SYMBOL_TAKEN";
  return null;
}

/** Everything plainly wrong in the draft, by the path of the field. */
export function liveProblems(draft: RegistryDraft, takenRegistrySymbols: ReadonlySet<string>): ReadonlyMap<FieldPath, FieldProblem> {
  const problems = new Map<FieldPath, FieldProblem>();
  if (draft.displayName.trim() === "") problems.set(REGISTRY_PATH.name, "NAME_EMPTY");
  const registrySymbol = symbolProblem(draft.symbol, takenRegistrySymbols);
  if (registrySymbol !== null) problems.set(REGISTRY_PATH.symbol, registrySymbol);
  if (draft.columns.length === 0) problems.set(REGISTRY_PATH.columns, "COLUMNS_MISSING");

  const seen = new Set<string>();
  draft.columns.forEach((column, index) => {
    if (column.displayName.trim() === "") problems.set(columnPath(index, COLUMN_FIELD.name), "NAME_EMPTY");
    const problem = symbolProblem(column.symbol, seen);
    if (problem !== null) problems.set(columnPath(index, COLUMN_FIELD.symbol), problem);
    seen.add(column.symbol);
    if (defaultOf(column) === "invalid") problems.set(columnPath(index, COLUMN_FIELD.default), "DEFAULT_INVALID");
  });
  return problems;
}

/** The request for a draft that has no live problem. */
export function requestOf(draft: RegistryDraft): CreateRegistryRequest {
  return {
    symbol: draft.symbol,
    displayName: draft.displayName.trim(),
    columns: draft.columns.map((column) => {
      const value = defaultOf(column);
      return {
        symbol: column.symbol,
        displayName: column.displayName.trim(),
        type: column.type,
        typeOptions: column.type === "number" ? { decimalPlaces: column.decimalPlaces } : {},
        required: column.required,
        ...(value === undefined || value === "invalid" ? {} : { defaultValue: value }),
      };
    }),
  };
}
