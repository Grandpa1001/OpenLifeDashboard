// Symbols and their suggestion (Architektura Załącznik C): a symbol is permanent, lower case, up to
// 40 characters, unique within its space. One rule here; the adapter checks the same rule before it
// builds any DDL, so no identifier is ever formed from text that did not pass it.
import { RESERVED_COLUMN_SYMBOLS } from "./sql-keywords.js";

export const SYMBOL_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
export const SYMBOL_MAX_LENGTH = 40;
/** The physical table of a registry is this prefix and its symbol, so it never meets a system table. */
export const REGISTRY_TABLE_PREFIX = "reg_";
export const tableNameOf = (symbol: string): string => `${REGISTRY_TABLE_PREFIX}${symbol}`;

/** Registries are told apart from each other, columns within their registry. */
export type SymbolSpace = "registry" | "column";
export type SymbolIssue = "SYMBOL_PATTERN" | "SYMBOL_TOO_LONG" | "SYMBOL_RESERVED" | "SYMBOL_TAKEN";

const isReserved = (symbol: string, space: SymbolSpace): boolean => space === "column" && RESERVED_COLUMN_SYMBOLS.has(symbol);

/** Why `symbol` cannot be used in `space`, or null. `taken` are the symbols already in that space (deleted ones too). */
export function checkSymbol(symbol: string, space: SymbolSpace, taken: ReadonlySet<string>): SymbolIssue | null {
  if (!SYMBOL_PATTERN.test(symbol)) return "SYMBOL_PATTERN";
  if (symbol.length > SYMBOL_MAX_LENGTH) return "SYMBOL_TOO_LONG";
  if (isReserved(symbol, space)) return "SYMBOL_RESERVED";
  if (taken.has(symbol)) return "SYMBOL_TAKEN";
  return null;
}

const POLISH: Readonly<Record<string, string>> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
const EMPTY_PREFIX = "pole";

/** The steps 1–4 of Załącznik C: a symbol that matches the pattern, before the check against the space. */
function baseOf(displayName: string): string {
  const transliterated = Array.from(displayName.toLowerCase(), (char) => POLISH[char] ?? char).join("");
  const separated = transliterated
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withoutLeadingDigits = separated.replace(/^[0-9]+/, "").replace(/^_+|_+$/g, "");
  const named = withoutLeadingDigits === "" ? EMPTY_PREFIX : withoutLeadingDigits;
  return named.slice(0, SYMBOL_MAX_LENGTH).replace(/_+$/, "");
}

/** The symbol offered for a display name; the owner may type another. A taken or reserved result gets `_2`, `_3`… */
export function suggestSymbol(displayName: string, space: SymbolSpace, taken: ReadonlySet<string>): string {
  const base = baseOf(displayName);
  const usable = (candidate: string): boolean => !taken.has(candidate) && !isReserved(candidate, space);
  if (usable(base)) return base;
  for (let counter = 2; ; counter += 1) {
    const suffix = `_${counter}`;
    const candidate = `${base.slice(0, SYMBOL_MAX_LENGTH - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (usable(candidate)) return candidate;
  }
}
