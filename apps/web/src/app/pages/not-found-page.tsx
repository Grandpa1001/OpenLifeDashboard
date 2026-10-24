import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation("common");
  return (
    <main>
      <h1>{t("notFound.title")}</h1>
      <Link to="/">{t("notFound.backHome")}</Link>
    </main>
  );
}
