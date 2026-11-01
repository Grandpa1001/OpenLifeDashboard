// The draft of an entry of ConfigTable while its window is open (makieta 23; D25.3). The value is
// the owner's text and is sent exactly as typed; only the name is trimmed. The web app does not
// import core, so the limits are its own copies of the rules of core/configuration, and a unit test
// holds them equal. The server stays the authority; these checks only save a round trip for what is
// plainly wrong, with the paths the server uses.
import { configFieldPath, type ConfigEntryDto } from "@openlife/contracts/http/config";
import { symbolProblem, type DraftProblem } from "./dictionary-draft.js";

/** The longest value and description, in code points (Architektura §14.2 `limits.textLength`; Scope §5.7). */
export const CONFIG_VALUE_MAX = 10_000;
export const CONFIG_DESCRIPTION_MAX = 500;

/** The path of every entry, as the page names it. */
export const CONFIG_PATH_PATTERN = configFieldPath("<symbol>");

export const CONFIG_FIELD = { name: "displayName", symbol: "symbol", value: "value", description: "description", entry: "entry" } as const;

export type EntryDraft = Readonly<{ displayName: string; symbol: string; symbolEdited: boolean; value: string; description: string }>;
export type EntryProblem = DraftProblem | "VALUE_TOO_LONG" | "DESCRIPTION_TOO_LONG" | "DESCRIPTION_INVALID";

export const EMPTY_ENTRY: EntryDraft = { displayName: "", symbol: "", symbolEdited: false, value: "", description: "" };

/** Code points, as the limits count them: a Polish letter or an emoji is one. */
export const codePoints = (text: string): number => Array.from(text).length;

// eslint-disable-next-line no-control-regex -- a control character in a description is what the rule refuses; a new line is allowed.
const DESCRIPTION_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u;

export const draftOfEntry = (entry: ConfigEntryDto): EntryDraft => ({ displayName: entry.displayName, symbol: entry.symbol, symbolEdited: true, value: entry.value, description: entry.description });

/**
 * Everything plainly wrong in the draft, by the path of the field. `takenSymbols` are the symbols of
 * the other entries when the entry is new; null when it is stored, and its symbol is fixed.
 */
export function entryProblems(draft: EntryDraft, takenSymbols: ReadonlySet<string> | null): ReadonlyMap<string, EntryProblem> {
  const problems = new Map<string, EntryProblem>();
  if (draft.displayName.trim() === "") problems.set(CONFIG_FIELD.name, "NAME_EMPTY");
  if (takenSymbols !== null) {
    const symbol = symbolProblem(draft.symbol, takenSymbols);
    if (symbol !== null) problems.set(CONFIG_FIELD.symbol, symbol);
  }
  if (codePoints(draft.value) > CONFIG_VALUE_MAX) problems.set(CONFIG_FIELD.value, "VALUE_TOO_LONG");
  if (codePoints(draft.description) > CONFIG_DESCRIPTION_MAX) problems.set(CONFIG_FIELD.description, "DESCRIPTION_TOO_LONG");
  else if (DESCRIPTION_CONTROL.test(draft.description)) problems.set(CONFIG_FIELD.description, "DESCRIPTION_INVALID");
  return problems;
}

/** What a save sends: the name trimmed, the value and the description as typed. */
export const contentOf = (draft: EntryDraft) => ({ displayName: draft.displayName.trim(), value: draft.value, description: draft.description });

/** Whether the draft would save anything other than what `entry` holds. */
export function isEntryChanged(draft: EntryDraft, entry: ConfigEntryDto): boolean {
  const content = contentOf(draft);
  return content.displayName !== entry.displayName || content.value !== entry.value || content.description !== entry.description;
}
