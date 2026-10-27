import { SUPPORTED_LOCALES } from "@openlife/contracts/locales";
import { useTranslation } from "react-i18next";
import { setInterfaceLanguage } from "../language.js";

/** The language of this session; the owner's saved preference arrives with the setup (D12.3). */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation("auth");
  const current = i18n.resolvedLanguage;
  return (
    <div className="language-switch" role="group" aria-label={t("language.label")}>
      {SUPPORTED_LOCALES.map((locale) => (
        <button key={locale} type="button" className="link-button" lang={locale} aria-pressed={current === locale} onClick={() => setInterfaceLanguage(locale)}>
          {t(`language.${locale}`)}
        </button>
      ))}
    </div>
  );
}
