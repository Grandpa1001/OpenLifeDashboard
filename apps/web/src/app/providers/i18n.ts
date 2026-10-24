import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "../../locales/en/common.json";
import plCommon from "../../locales/pl/common.json";

// Polish is the source language (Architektura §7.5). Until owner preferences exist (D11/D12)
// the language follows the browser.
export const SUPPORTED_LOCALES = ["pl", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const SOURCE_LOCALE: Locale = "pl";

export function browserLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    const match = SUPPORTED_LOCALES.find((locale) => locale === base);
    if (match) {
      return match;
    }
  }
  return SOURCE_LOCALE;
}

export async function initI18n(locale: Locale): Promise<typeof i18next> {
  await i18next.use(initReactI18next).init({
    lng: locale,
    fallbackLng: SOURCE_LOCALE,
    supportedLngs: SUPPORTED_LOCALES,
    defaultNS: "common",
    ns: ["common"],
    resources: { pl: { common: plCommon }, en: { common: enCommon } },
    interpolation: { escapeValue: false }, // React escapes rendered text.
  });
  return i18next;
}
