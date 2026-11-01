// The text of a refusal of a field of an entry of ConfigTable, by the code the server (or the live
// check) gives. The codes shared with the registries keep their texts; a symbol taken means another
// entry of ConfigTable.
import type { TFunction } from "i18next";

const SHARED = ["NAME_EMPTY", "NAME_TOO_LONG", "NAME_INVALID", "SYMBOL_EMPTY", "SYMBOL_PATTERN", "SYMBOL_TOO_LONG", "SYMBOL_RESERVED"] as const;
const OWN = ["SYMBOL_TAKEN", "VALUE_NOT_TEXT", "VALUE_TOO_LONG", "VALUE_INVALID", "DESCRIPTION_NOT_TEXT", "DESCRIPTION_TOO_LONG", "DESCRIPTION_INVALID", "LIMIT_ENTRIES"] as const;
const isIn = <T extends string>(list: readonly T[], code: string): code is T => (list as readonly string[]).includes(code);

export function configIssueText(t: TFunction<"registers">, code: string): string {
  if (isIn(SHARED, code)) return t(`issues.${code}`);
  if (isIn(OWN, code)) return t(`config.issues.${code}`);
  return t("issues.UNKNOWN");
}
