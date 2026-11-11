// D42.3 — the texts of the Settings in both languages (Architektura §7.5, §14.1). The Application page reads
// everything about an option from the catalog and shows it through the translations: the label by the
// option's `labelKey`, its group by the part of the key before the dot, its unit and the listed levels of a
// text option. A missing text would show a bare key on the page, and the compiler cannot see it because the
// keys come from data, so this test walks the catalog.
// AC1: every label, group, unit and listed level of the catalog has a text in Polish and in English.
import { readFileSync } from "node:fs";
import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { describe, expect, it } from "vitest";

type Texts = Record<string, unknown>;
const LANGUAGES = ["pl", "en"] as const;

function load(language: string): Texts {
  const file = new URL(`../../../apps/web/src/locales/${language}/settings.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Texts;
}

/** The text at a dotted path, or undefined when a part of the path is missing or the end is not a text. */
function textAt(texts: Texts, path: string): string | undefined {
  let current: unknown = texts;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Texts)[part];
  }
  return typeof current === "string" && current.trim() !== "" ? current : undefined;
}

/** Every path the page asks the translations for, taken from the catalog alone. */
function pathsOfCatalog(): string[] {
  const paths = new Set<string>();
  for (const option of SETTINGS_CATALOG) {
    expect(option.labelKey.startsWith("settings:"), `${option.key}: the label is in the settings namespace`).toBe(true);
    paths.add(option.labelKey.replace(/^settings:/, ""));
    paths.add(`groups.${option.key.split(".")[0]}`);
    if (option.type === "integer") paths.add(`units.${option.unit}`);
    if (option.key === "logs.level" && option.type === "enum") for (const value of option.values) paths.add(`levels.${value}`);
  }
  return [...paths].sort();
}

describe("D42.3 the translations of the catalog", () => {
  it("has a text in every language for each label, group, unit and level the catalog asks for", () => {
    const paths = pathsOfCatalog();
    expect(paths.length).toBeGreaterThan(SETTINGS_CATALOG.length);
    for (const language of LANGUAGES) {
      const texts = load(language);
      const missing = paths.filter((path) => textAt(texts, path) === undefined);
      expect(missing, `${language}: texts missing in settings.json`).toEqual([]);
    }
  });

  it("gives each option its own label, so two options never read the same", () => {
    for (const language of LANGUAGES) {
      const texts = load(language);
      const labels = SETTINGS_CATALOG.map((option) => textAt(texts, option.labelKey.replace(/^settings:/, "")));
      expect(new Set(labels).size, `${language}: repeated labels`).toBe(SETTINGS_CATALOG.length);
    }
  });

  it("catches a label that is not translated (a catalog key with no text is reported)", () => {
    const texts = load("en");
    expect(textAt(texts, "options.noSuchOption")).toBeUndefined();
    expect(textAt(texts, "groups")).toBeUndefined();
  });
});
