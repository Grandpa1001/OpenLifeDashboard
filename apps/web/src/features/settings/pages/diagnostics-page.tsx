import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchDiagnostics } from "../api/diagnostics.js";
import { DiagnosticsErrors } from "../components/diagnostics-errors.js";
import { DiagnosticsFiles } from "../components/diagnostics-files.js";
import { DiagnosticsOverview } from "../components/diagnostics-overview.js";
import { DiagnosticsPaths } from "../components/diagnostics-paths.js";
import { DiagnosticsSearch } from "../components/diagnostics-search.js";

/**
 * `/settings/diagnostics` (Scope §5.9; Architektura §15.3; D44.6): where the installation is and how it is
 * doing, the latest errors, the files of the log and the report to download, and the search of the log by a
 * request id. All of it comes from the server's lists; nothing here is a path the browser could open.
 */
export function DiagnosticsPage() {
  const { t } = useTranslation("settings");
  const display = useOwnerDisplay();
  const overview = useQuery({
    queryKey: queryKeys.diagnostics.overview,
    queryFn: async ({ signal }) => {
      const result = await fetchDiagnostics(signal);
      if (!result.ok) throw new Error("diagnostics unavailable");
      return result.value;
    },
  });
  // A request id taken from the table of errors remounts the search, which then looks for it at once.
  const [handedOver, setHandedOver] = useState<Readonly<{ id: string; turn: number }>>({ id: "", turn: 0 });
  return (
    <>
      <h2 className="visually-hidden">{t("diagnostics.heading")}</h2>
      {overview.isPending ? <p role="status">{t("loading")}</p> : null}
      {overview.isError ? (
        <div className="card">
          <p role="alert">{t("security.loadFailed")}</p>
          <button type="button" onClick={() => void overview.refetch()}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      {overview.data === undefined ? null : (
        <>
          <DiagnosticsOverview data={overview.data} locale={display.locale} />
          <DiagnosticsPaths data={overview.data} />
          <DiagnosticsErrors errors={overview.data.recentErrors} onFind={(id) => setHandedOver((previous) => ({ id, turn: previous.turn + 1 }))} />
        </>
      )}
      <DiagnosticsFiles />
      <DiagnosticsSearch key={handedOver.turn} preset={handedOver.id} />
    </>
  );
}
