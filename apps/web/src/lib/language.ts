import type { Locale } from "@openlife/contracts/locales";
import i18next from "i18next";

/** Switches the interface language of the page: the texts and the `lang` of the document together. */
export function setInterfaceLanguage(locale: Locale): void {
  void i18next.changeLanguage(locale);
  document.documentElement.lang = locale;
}
