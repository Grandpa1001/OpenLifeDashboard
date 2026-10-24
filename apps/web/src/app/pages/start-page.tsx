import { useTranslation } from "react-i18next";

/** Placeholder start page: no owner data and no sign-in imitation before D09–D12. */
export function StartPage() {
  const { t } = useTranslation("common");
  return (
    <main>
      <h1>{t("start.title")}</h1>
      <p>{t("start.status")}</p>
    </main>
  );
}
