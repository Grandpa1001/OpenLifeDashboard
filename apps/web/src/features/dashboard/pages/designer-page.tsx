import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** The place of the Designer (D18.2): the route exists so the links of the screen lead somewhere, and it says what is missing. */
export function DesignerPage() {
  const { t } = useTranslation("common");
  return (
    <main className="page">
      <h1>{t("designer.title")}</h1>
      <p>{t("designer.soon")}</p>
      <Link to="/main">{t("designer.back")}</Link>
    </main>
  );
}
