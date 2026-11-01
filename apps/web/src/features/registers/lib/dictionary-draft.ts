// The draft of a dictionary while its editor is open (makieta 22; D24.3): its name and its values in
// their order. A value already stored keeps its symbol, which never changes (§9.20); a value added
// here gets a symbol offered from its label, editable until it is saved. The rules are the server's;
// these checks only save a round trip for what is plainly wrong, with the paths the server uses.
import type { DictionaryDto, SaveDictionaryRequest } from "@openlife/contracts/http/dictionaries";
import { suggestSymbol, SYMBOL_MAX_LENGTH, SYMBOL_PATTERN } from "./suggest-symbol.js";

export type ValueDraft = Readonly<{
  /** Identity of the row in the editor, not of the value. */
  key: number;
  symbol: string;
  label: string;
  hidden: boolean;
  /** The value is in the stored dictionary: its symbol is fixed, and removing it asks first. */
  stored: boolean;
  /** True once the owner typed the symbol of a new value: it no longer follows the label. */
  symbolEdited: boolean;
}>;

export type DictionaryDraft = Readonly<{ displayName: string; values: readonly ValueDraft[] }>;

export type DraftProblem = "NAME_EMPTY" | "SYMBOL_EMPTY" | "SYMBOL_PATTERN" | "SYMBOL_TOO_LONG" | "SYMBOL_TAKEN";

export const DICTIONARY_PATH = { name: "displayName", symbol: "symbol", values: "values", dictionary: "dictionary" } as const;
export const valuePath = (index: number, field: "symbol" | "label" | "hidden"): string => `${DICTIONARY_PATH.values}.${index}.${field}`;
/** The paths of the fields of the value at `index`, by name. */
export const valuePaths = (index: number) => ({ symbol: valuePath(index, "symbol"), label: valuePath(index, "label") });

export const draftOf = (dictionary: DictionaryDto): DictionaryDraft => ({
  displayName: dictionary.displayName,
  values: dictionary.values.map((value, index) => ({ key: index, symbol: value.symbol, label: value.label, hidden: value.hidden, stored: true, symbolEdited: true })),
});

/** A new, empty value at the end of the list; its key is past every key the draft has. */
export function withNewValue(draft: DictionaryDraft): DictionaryDraft {
  const key = draft.values.reduce((max, value) => Math.max(max, value.key), -1) + 1;
  return { ...draft, values: [...draft.values, { key, symbol: "", label: "", hidden: false, stored: false, symbolEdited: false }] };
}

/** The label of the value at `index`; a new value whose symbol was not typed gets one offered from it, free in this dictionary. */
export function withLabel(draft: DictionaryDraft, index: number, label: string): DictionaryDraft {
  return {
    ...draft,
    values: draft.values.map((value, at) => {
      if (at !== index) return value;
      if (value.stored || value.symbolEdited) return { ...value, label };
      const taken = new Set(draft.values.filter((_, other) => other !== index).map((other) => other.symbol));
      return { ...value, label, symbol: label.trim() === "" ? "" : suggestSymbol(label, taken) };
    }),
  };
}

/** The value at `from` moved to `to`, the others keeping their order; a move past either end stays at it. */
export function moved<T>(items: readonly T[], from: number, to: number): readonly T[] {
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (from === target || from < 0 || from >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

export function symbolProblem(symbol: string, taken: ReadonlySet<string>): DraftProblem | null {
  if (symbol === "") return "SYMBOL_EMPTY";
  if (!SYMBOL_PATTERN.test(symbol)) return "SYMBOL_PATTERN";
  if (symbol.length > SYMBOL_MAX_LENGTH) return "SYMBOL_TOO_LONG";
  if (taken.has(symbol)) return "SYMBOL_TAKEN";
  return null;
}

/** Everything plainly wrong in the draft, by the path of the field; a repeated symbol is told at its second row. */
export function draftProblems(draft: DictionaryDraft): ReadonlyMap<string, DraftProblem> {
  const problems = new Map<string, DraftProblem>();
  if (draft.displayName.trim() === "") problems.set(DICTIONARY_PATH.name, "NAME_EMPTY");
  const seen = new Set<string>();
  draft.values.forEach((value, index) => {
    if (value.label.trim() === "") problems.set(valuePath(index, "label"), "NAME_EMPTY");
    const problem = symbolProblem(value.symbol, seen);
    if (problem !== null) problems.set(valuePath(index, "symbol"), problem);
    seen.add(value.symbol);
  });
  return problems;
}

/** The whole content as it is saved, in the order of the rows. */
export const requestOf = (draft: DictionaryDraft, expectedRevision: number): SaveDictionaryRequest => ({
  expectedRevision,
  displayName: draft.displayName.trim(),
  values: draft.values.map((value) => ({ symbol: value.symbol, label: value.label.trim(), hidden: value.hidden })),
});

/** Whether the draft would save anything other than what `dictionary` holds. */
export function isChanged(draft: DictionaryDraft, dictionary: DictionaryDto): boolean {
  const saved = requestOf(draft, dictionary.revision);
  return JSON.stringify([saved.displayName, saved.values]) !== JSON.stringify([dictionary.displayName, dictionary.values]);
}

/** A value the field of a record offers: the stored symbol and what the list shows for it. */
export type ChoiceOption = Readonly<{ value: string; label: string }>;

/**
 * The options of the field of a record whose column has a dictionary (§9.20): the values that are
 * not hidden, in the order of the dictionary. The value the field holds stays an option when it is
 * hidden (with its label) or unknown to the dictionary (as it is stored), so that changing another
 * field does not change it.
 */
export function choiceOptions(values: DictionaryDto["values"], current: string): readonly ChoiceOption[] {
  const offered = values.filter((value) => !value.hidden).map((value) => ({ value: value.symbol, label: value.label }));
  if (current === "" || offered.some((option) => option.value === current)) return offered;
  const kept = values.find((value) => value.symbol === current);
  return [...offered, { value: current, label: kept?.label ?? current }];
}
