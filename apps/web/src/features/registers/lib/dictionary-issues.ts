// The text of a refusal of a dictionary field, by the path and code the server (or the live check)
// gives. The codes shared with the registries keep their texts; a symbol taken means another
// dictionary when it is the dictionary's, and another value of this one when it is a value's.
import type { TFunction } from "i18next";

const SHARED = ["NAME_EMPTY", "NAME_TOO_LONG", "NAME_INVALID", "SYMBOL_EMPTY", "SYMBOL_PATTERN", "SYMBOL_TOO_LONG", "SYMBOL_RESERVED"] as const;
const OWN = ["LIMIT_VALUES", "LIMIT_DICTIONARIES", "VALUES_NOT_LIST", "VALUE_NOT_OBJECT", "HIDDEN_INVALID"] as const;
const isIn = <T extends string>(list: readonly T[], code: string): code is T => (list as readonly string[]).includes(code);

export function dictionaryIssueText(t: TFunction<"registers">, path: string, code: string): string {
  if (code === "SYMBOL_TAKEN") return path.startsWith("values.") ? t("dictionaries.issues.VALUE_SYMBOL_TAKEN") : t("dictionaries.issues.SYMBOL_TAKEN");
  if (isIn(SHARED, code)) return t(`issues.${code}`);
  if (isIn(OWN, code)) return t(`dictionaries.issues.${code}`);
  return t("issues.UNKNOWN");
}
