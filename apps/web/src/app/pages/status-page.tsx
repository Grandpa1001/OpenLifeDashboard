import { useTranslation } from "react-i18next";
import { useServiceStatus } from "../api/service-status.js";

/**
 * Start screen until the owner's sign-in exists (D09–D12): whether the server is ready or not.
 * It offers no form and shows no installation detail (paths, keys, versions), only the status.
 */
export function StatusPage() {
  const { t } = useTranslation("common");
  const { status, recheck } = useServiceStatus();
  return (
    <main className="status-page">
      <h1>{t("status.title")}</h1>
      <section className="status-card" aria-labelledby="status-heading" data-status={status}>
        <div role="status" aria-live="polite">
          {status === "checking" ? (
            <h2 id="status-heading">{t("status.checking")}</h2>
          ) : (
            <>
              <h2 id="status-heading">
                <span className="status-dot" aria-hidden="true" />
                {t(status === "ready" ? "status.ready.heading" : "status.unavailable.heading")}
              </h2>
              <p>{t(status === "ready" ? "status.ready.description" : "status.unavailable.description")}</p>
            </>
          )}
        </div>
        <button type="button" onClick={recheck} disabled={status === "checking"}>
          {t("status.recheck")}
        </button>
      </section>
    </main>
  );
}
