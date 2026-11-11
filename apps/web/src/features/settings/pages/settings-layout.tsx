import { Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/**
 * The frame of the settings (Scope §4, §5.9; D42.1): the title and the sections as links, the link of the
 * page that is open marked by the router with `aria-current="page"`. The pages are its children.
 */
export function SettingsLayout() {
  const { t } = useTranslation("settings");
  return (
    <main className="page settings-page">
      <h1>{t("title")}</h1>
      <nav aria-label={t("navigation")} className="settings-nav">
        <Link to="/settings/account">{t("tabs.account")}</Link>
        <Link to="/settings/style">{t("tabs.style")}</Link>
        <Link to="/settings/app">{t("tabs.app")}</Link>
      </nav>
      <Outlet />
    </main>
  );
}
