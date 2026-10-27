import { SOURCE_LOCALE, SUPPORTED_LOCALES, type Locale } from "@openlife/contracts/locales";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import enAuth from "../../locales/en/auth.json";
import enCommon from "../../locales/en/common.json";
import enErrors from "../../locales/en/errors.json";
import enRegisters from "../../locales/en/registers.json";
import enSetup from "../../locales/en/setup.json";
import plAuth from "../../locales/pl/auth.json";
import plCommon from "../../locales/pl/common.json";
import plErrors from "../../locales/pl/errors.json";
import plRegisters from "../../locales/pl/registers.json";
import plSetup from "../../locales/pl/setup.json";

// The language follows the browser until the owner saves a preference (D12.3), and the sign-in
// screens offer a switch for the session.

// Keys are typed from the Polish source files: t() with a key missing there does not compile.
// scripts/check-locales.ts keeps every other language to the same keys.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: { common: typeof plCommon; auth: typeof plAuth; errors: typeof plErrors; registers: typeof plRegisters; setup: typeof plSetup };
  }
}

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
    ns: ["common", "auth", "errors", "registers", "setup"],
    resources: { pl: { common: plCommon, auth: plAuth, errors: plErrors, registers: plRegisters, setup: plSetup }, en: { common: enCommon, auth: enAuth, errors: enErrors, registers: enRegisters, setup: enSetup } },
    interpolation: { escapeValue: false }, // React escapes rendered text.
  });
  return i18next;
}
