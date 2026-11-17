import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { isGoingOn } from "../../lib/updates/operation-view.js";
import { updatesStatusQuery } from "../../lib/updates/updates-status.js";

/**
 * The running version in the corner of the part of the application (Scope §5.9; D53.4): quiet text that leads to
 * the page of the updates, with a dot when a newer stable release is known. It says nothing while the state is
 * unknown (a failed read shows no version rather than a wrong one) and nothing about a release that is not newer.
 * The visible text opens the name of the link, so the name never contradicts what is shown.
 */
export function VersionMark() {
  const { t } = useTranslation("common");
  const status = useQuery(updatesStatusQuery);
  if (status.data === undefined) return null;
  const { current, available, latest, configured, operation } = status.data;
  const updating = isGoingOn(operation);
  const newer = configured && available && latest !== null ? latest.version : null;
  return (
    <nav aria-label={t("version.navigation")} className="version-mark">
      <Link to="/settings/updates">
        <span>{t("version.short", { current })}</span>
        <span className="visually-hidden"> {updating ? `${t("version.updating")} ` : newer === null ? "" : `${t("version.newer", { latest: newer })} `}{t("version.open")}</span>
        {updating ? <span className="version-busy" aria-hidden="true" /> : newer === null ? null : <span className="version-dot" aria-hidden="true" />}
      </Link>
    </nav>
  );
}
