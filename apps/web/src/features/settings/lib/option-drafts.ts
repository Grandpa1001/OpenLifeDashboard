// What the owner is typing into the options of the Application page (Architektura §14.3; D42.2): a text
// or a flag for each option, turned into the value the option wants, or into the reason it cannot be
// yet. The server checks again; this is the answer given before the request.
import type { SettingDto } from "@openlife/contracts/http/settings";

/** What an input holds: a text, or a flag for a boolean option. */
export type OptionDraft = string | boolean;

export type ParsedOption = Readonly<{ ok: true; value: number | boolean | string }> | Readonly<{ ok: false; code: "NOT_INTEGER" | "OUT_OF_RANGE" | "NOT_LISTED" | "NOT_TIME" }>;

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The draft an input starts from: the value as a text, or the flag. */
export const draftOf = (setting: SettingDto): OptionDraft => (typeof setting.value === "boolean" ? setting.value : String(setting.value));

/** The value the draft stands for, or why it is not one. */
export function parseDraft(setting: SettingDto, draft: OptionDraft): ParsedOption {
  switch (setting.type) {
    case "boolean":
      return { ok: true, value: draft === true };
    case "integer": {
      const text = String(draft).trim();
      if (!/^\d{1,9}$/.test(text)) return { ok: false, code: "NOT_INTEGER" };
      const value = Number(text);
      return (setting.min !== undefined && value < setting.min) || (setting.max !== undefined && value > setting.max) ? { ok: false, code: "OUT_OF_RANGE" } : { ok: true, value };
    }
    case "enum":
      return typeof draft === "string" && (setting.values ?? []).includes(draft) ? { ok: true, value: draft } : { ok: false, code: "NOT_LISTED" };
    case "time":
      return typeof draft === "string" && TIME_OF_DAY.test(draft) ? { ok: true, value: draft } : { ok: false, code: "NOT_TIME" };
  }
}

/** The options whose draft differs from the value they have, with the value to send, and the ones whose draft cannot be sent yet. */
export function changesOf(settings: readonly SettingDto[], drafts: Readonly<Record<string, OptionDraft>>): Readonly<{ values: Record<string, number | boolean | string>; invalid: Record<string, ParsedOption & { ok: false }> }> {
  const values: Record<string, number | boolean | string> = {};
  const invalid: Record<string, ParsedOption & { ok: false }> = {};
  for (const setting of settings) {
    if (!Object.hasOwn(drafts, setting.key)) continue;
    const parsed = parseDraft(setting, drafts[setting.key]!);
    if (!parsed.ok) invalid[setting.key] = parsed;
    else if (parsed.value !== setting.value) values[setting.key] = parsed.value;
  }
  return { values, invalid };
}

/** The group of an option in the page: the part of its key before the dot. */
export const groupOf = (key: string): string => key.slice(0, key.indexOf("."));
