import { SOURCE_LOCALE, SUPPORTED_LOCALES, type Locale } from "@openlife/contracts/locales";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import enAuth from "../../locales/en/auth.json";
import enCommon from "../../locales/en/common.json";
import enDesigner from "../../locales/en/designer.json";
import enErrors from "../../locales/en/errors.json";
import enRegisters from "../../locales/en/registers.json";
import enWidgets from "../../locales/en/widgets.json";
import enSetup from "../../locales/en/setup.json";
import enSettings from "../../locales/en/settings.json";
import plAuth from "../../locales/pl/auth.json";
import plCommon from "../../locales/pl/common.json";
import plDesigner from "../../locales/pl/designer.json";
import plErrors from "../../locales/pl/errors.json";
import plRegisters from "../../locales/pl/registers.json";
import plWidgets from "../../locales/pl/widgets.json";
import plSetup from "../../locales/pl/setup.json";
import plSettings from "../../locales/pl/settings.json";

// The language follows the browser until the owner saves a preference (D12.3), and the sign-in
// screens offer a switch for the session.

// Keys are typed from the Polish source files: t() with a key missing there does not compile.
// scripts/check-locales.ts keeps every other language to the same keys.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: { common: typeof plCommon; designer: typeof plDesigner; auth: typeof plAuth; errors: typeof plErrors; registers: typeof plRegisters; setup: typeof plSetup; settings: typeof plSettings; widgets: typeof plWidgets };
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
    ns: ["common", "auth", "designer", "errors", "registers", "setup", "settings", "widgets"],
    resources: { pl: { common: plCommon, designer: plDesigner, auth: plAuth, errors: plErrors, registers: plRegisters, setup: plSetup, settings: plSettings, widgets: plWidgets }, en: { common: enCommon, designer: enDesigner, auth: enAuth, errors: enErrors, registers: enRegisters, setup: enSetup, settings: enSettings, widgets: enWidgets } },
    interpolation: { escapeValue: false }, // React escapes rendered text.
  });
  return i18next;
}
