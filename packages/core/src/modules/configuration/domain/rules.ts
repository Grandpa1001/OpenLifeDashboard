// The rules of an entry of ConfigTable (Scope §5.7, §6.1, Architektura §4.2, §14.1, Załącznik C;
// D25.1). An entry is the owner's own text, never a setting of the system: its value is a JSON
// string kept exactly as it came, without trimming, and a widget that wants a number or a date parses
// it itself. Its symbol follows the rule of every symbol of the catalogs and never changes; its name
// follows the rule of every display name.
import { checkDisplayName, checkSymbol, type DisplayNameIssue, type SymbolIssue } from "../../registries/public.js";

/** Limits of ConfigTable (Architektura §14.2: `limits.configEntries`, `limits.textLength`), as the values the rules use until the option catalog (D41) passes others. */
export type ConfigLimits = Readonly<{ maxEntries: number; valueMaxCodePoints: number; descriptionMaxCodePoints: number }>;
export const DEFAULT_CONFIG_LIMITS: ConfigLimits = { maxEntries: 500, valueMaxCodePoints: 10_000, descriptionMaxCodePoints: 500 };

export type ConfigIssueCode = SymbolIssue | DisplayNameIssue | "VALUE_NOT_TEXT" | "VALUE_TOO_LONG" | "VALUE_INVALID" | "DESCRIPTION_NOT_TEXT" | "DESCRIPTION_TOO_LONG" | "DESCRIPTION_INVALID" | "LIMIT_ENTRIES";
export type ConfigIssue = Readonly<{ path: string; code: ConfigIssueCode }>;

/** The part of an entry its owner changes: everything but the symbol. */
export type ConfigContent = Readonly<{ displayName: string; value: string; description: string }>;
export type NewConfigEntry = ConfigContent & Readonly<{ symbol: string }>;

export type ConfigRulesResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; issues: readonly ConfigIssue[] }>;

// eslint-disable-next-line no-control-regex -- a control character in a description is exactly what is refused; a new line is allowed.
const DESCRIPTION_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const codePoints = (text: string): number => Array.from(text).length;

/**
 * The name, the value and the description, every problem with the path of its field. A text with a
 * lone surrogate would not come back from SQLite as it was sent, so it is refused instead.
 */
function checkContent(draft: Readonly<Record<string, unknown>>, limits: ConfigLimits, issues: ConfigIssue[]): ConfigContent | null {
  const name = checkDisplayName(draft["displayName"]);
  if (!name.ok) issues.push({ path: "displayName", code: name.issue });

  const value = draft["value"];
  if (typeof value !== "string") issues.push({ path: "value", code: "VALUE_NOT_TEXT" });
  else if (codePoints(value) > limits.valueMaxCodePoints) issues.push({ path: "value", code: "VALUE_TOO_LONG" });
  else if (!value.isWellFormed()) issues.push({ path: "value", code: "VALUE_INVALID" });

  const description = draft["description"] ?? "";
  if (typeof description !== "string") issues.push({ path: "description", code: "DESCRIPTION_NOT_TEXT" });
  else if (codePoints(description) > limits.descriptionMaxCodePoints) issues.push({ path: "description", code: "DESCRIPTION_TOO_LONG" });
  else if (!description.isWellFormed() || DESCRIPTION_CONTROL.test(description)) issues.push({ path: "description", code: "DESCRIPTION_INVALID" });

  return name.ok && issues.length === 0 ? { displayName: name.name, value: value as string, description: description as string } : null;
}

/** An entry that does not exist yet: its symbol must be free among the owner's entries, and the limit not reached. */
export function validateNewConfigEntry(draft: unknown, context: Readonly<{ limits: ConfigLimits; takenSymbols: ReadonlySet<string>; count: number }>): ConfigRulesResult<NewConfigEntry> {
  const issues: ConfigIssue[] = [];
  const fields = isObject(draft) ? draft : {};
  if (context.count >= context.limits.maxEntries) issues.push({ path: "entry", code: "LIMIT_ENTRIES" });
  const symbol = fields["symbol"];
  const symbolIssue = typeof symbol === "string" ? checkSymbol(symbol, "configEntry", context.takenSymbols) : "SYMBOL_PATTERN";
  if (symbolIssue !== null) issues.push({ path: "symbol", code: symbolIssue });
  const content = checkContent(fields, context.limits, issues);
  return issues.length === 0 && content !== null ? { ok: true, value: { symbol: symbol as string, ...content } } : { ok: false, issues };
}

/** The new content of a stored entry: its name, value and description; the symbol is not part of it. */
export function validateConfigContent(draft: unknown, limits: ConfigLimits): ConfigRulesResult<ConfigContent> {
  const issues: ConfigIssue[] = [];
  const content = checkContent(isObject(draft) ? draft : {}, limits, issues);
  return issues.length === 0 && content !== null ? { ok: true, value: content } : { ok: false, issues };
}
