// The rules of a dictionary and its values (Scope §5.8, Architektura §4.2, Załącznik C; D24.1). A
// dictionary only shows a symbol as a label and offers values to choose: nothing here touches a
// record. Its symbol and the symbol of each value follow the rule of every symbol of the catalogs;
// its name and the label of a value follow the rule of every display name. A value is known by its
// symbol, which never changes; its label, its place and whether it is hidden do. The order of the
// list is the order of the values.
import { checkDisplayName, checkSymbol, type DisplayNameIssue, type SymbolIssue } from "../../registries/public.js";

/** Limits of the dictionaries (Architektura §14.2), as the values the rules use until the option catalog (D41) passes others. */
export type DictionaryLimits = Readonly<{ maxDictionaries: number; maxValues: number }>;
export const DEFAULT_DICTIONARY_LIMITS: DictionaryLimits = { maxDictionaries: 200, maxValues: 500 };

export type DictionaryIssueCode = SymbolIssue | DisplayNameIssue | "VALUES_NOT_LIST" | "VALUE_NOT_OBJECT" | "HIDDEN_INVALID" | "LIMIT_VALUES" | "LIMIT_DICTIONARIES";
export type DictionaryIssue = Readonly<{ path: string; code: DictionaryIssueCode }>;

export type DictionaryValue = Readonly<{ symbol: string; label: string; hidden: boolean }>;
/** The part of a dictionary its owner changes: its name and its values in their order. */
export type DictionaryContent = Readonly<{ displayName: string; values: readonly DictionaryValue[] }>;
export type NewDictionary = DictionaryContent & Readonly<{ symbol: string }>;

export type DictionaryRulesResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; issues: readonly DictionaryIssue[] }>;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The name and the values, every problem with the path of its field. */
function checkContent(draft: Readonly<Record<string, unknown>>, limits: DictionaryLimits, issues: DictionaryIssue[]): DictionaryContent | null {
  const name = checkDisplayName(draft["displayName"]);
  if (!name.ok) issues.push({ path: "displayName", code: name.issue });

  const raw = draft["values"] ?? [];
  if (!Array.isArray(raw)) {
    issues.push({ path: "values", code: "VALUES_NOT_LIST" });
    return null;
  }
  if (raw.length > limits.maxValues) issues.push({ path: "values", code: "LIMIT_VALUES" });

  const values: DictionaryValue[] = [];
  const taken = new Set<string>();
  raw.slice(0, limits.maxValues).forEach((entry: unknown, position) => {
    const at = `values.${position}`;
    if (!isObject(entry)) {
      issues.push({ path: at, code: "VALUE_NOT_OBJECT" });
      return;
    }
    const symbol = entry["symbol"];
    const symbolIssue = typeof symbol === "string" ? checkSymbol(symbol, "dictionaryValue", taken) : "SYMBOL_PATTERN";
    if (symbolIssue !== null) issues.push({ path: `${at}.symbol`, code: symbolIssue });
    if (typeof symbol === "string") taken.add(symbol);
    const label = checkDisplayName(entry["label"]);
    if (!label.ok) issues.push({ path: `${at}.label`, code: label.issue });
    const hidden = entry["hidden"] ?? false;
    if (typeof hidden !== "boolean") issues.push({ path: `${at}.hidden`, code: "HIDDEN_INVALID" });
    if (symbolIssue === null && label.ok && typeof hidden === "boolean") values.push({ symbol: symbol as string, label: label.name, hidden });
  });
  return name.ok ? { displayName: name.name, values } : null;
}

/** A dictionary that does not exist yet: its symbol must be free among the owner's dictionaries, and the limit not reached. */
export function validateNewDictionary(draft: unknown, context: Readonly<{ limits: DictionaryLimits; takenSymbols: ReadonlySet<string>; count: number }>): DictionaryRulesResult<NewDictionary> {
  const issues: DictionaryIssue[] = [];
  const fields = isObject(draft) ? draft : {};
  if (context.count >= context.limits.maxDictionaries) issues.push({ path: "dictionary", code: "LIMIT_DICTIONARIES" });
  const symbol = fields["symbol"];
  const symbolIssue = typeof symbol === "string" ? checkSymbol(symbol, "dictionary", context.takenSymbols) : "SYMBOL_PATTERN";
  if (symbolIssue !== null) issues.push({ path: "symbol", code: symbolIssue });
  const content = checkContent(fields, context.limits, issues);
  return issues.length === 0 && content !== null ? { ok: true, value: { symbol: symbol as string, ...content } } : { ok: false, issues };
}

/** The new content of a stored dictionary: the whole list, in order; a value left out is removed, a new symbol is added. */
export function validateDictionaryContent(draft: unknown, limits: DictionaryLimits): DictionaryRulesResult<DictionaryContent> {
  const issues: DictionaryIssue[] = [];
  const content = checkContent(isObject(draft) ? draft : {}, limits, issues);
  return issues.length === 0 && content !== null ? { ok: true, value: content } : { ok: false, issues };
}

/** What a save changed in the list of values, for the audit: the symbols that came and went (labels stay out of it). */
export function valueChanges(before: readonly Pick<DictionaryValue, "symbol">[], after: readonly Pick<DictionaryValue, "symbol">[]): Readonly<{ added: string[]; removed: string[] }> {
  const old = new Set(before.map((value) => value.symbol));
  const next = new Set(after.map((value) => value.symbol));
  return { added: [...next].filter((symbol) => !old.has(symbol)), removed: [...old].filter((symbol) => !next.has(symbol)) };
}
