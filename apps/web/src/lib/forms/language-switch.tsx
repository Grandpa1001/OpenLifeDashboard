import { SUPPORTED_LOCALES, type Locale } from "@openlife/contracts/locales";
import { useTranslation } from "react-i18next";

/** The language of this session; the owner's saved preference arrives with the setup (D12.3). */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation("auth");
  const current = i18n.resolvedLanguage;
  const change = (locale: Locale): void => {
    void i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
  };
  return (
    <div className="language-switch" role="group" aria-label={t("language.label")}>
      {SUPPORTED_LOCALES.map((locale) => (
        <button key={locale} type="button" className="link-button" lang={locale} aria-pressed={current === locale} onClick={() => change(locale)}>
          {t(`language.${locale}`)}
        </button>
      ))}
    </div>
  );
}
