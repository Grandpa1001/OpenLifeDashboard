import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { formatByteSize } from "../../../lib/format/byte-size.js";
import { formatCell } from "../../../lib/format/cell-format.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { fetchLogFiles, logFileDownloadPath, REPORT_DOWNLOAD_PATH } from "../api/diagnostics.js";
import { TableScroll } from "./table-scroll.js";

const DATETIME = { type: "datetime", typeOptions: {} } as const;

/**
 * The files of the technical log and the diagnostic report (Architektura §15.3; D44.6). A download is a link to
 * the route of the server: the browser sends the session with it and saves the file, the page never holds its
 * content. The names come from the server's list; the report is built from a list of fields and goes nowhere
 * by itself.
 */
export function DiagnosticsFiles() {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const display = useOwnerDisplay();
  const files = useQuery({
    queryKey: queryKeys.diagnostics.logFiles,
    queryFn: async ({ signal }) => {
      const result = await fetchLogFiles(signal);
      if (!result.ok) throw new Error("log files unavailable");
      return result.value.files;
    },
  });
  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("diagnostics.files.heading")}</h2>
      <p className="field-hint">{t("diagnostics.files.hint")}</p>
      {files.isPending ? <p role="status">{t("loading")}</p> : null}
      {files.isError ? (
        <>
          <p role="alert">{t("security.loadFailed")}</p>
          <button type="button" onClick={() => void files.refetch()}>
            {t("retry")}
          </button>
        </>
      ) : null}
      {files.data === undefined ? null : files.data.length === 0 ? (
        <p>{t("diagnostics.files.none")}</p>
      ) : (
        <TableScroll labelledBy={headingId}>
          <table className="security-table">
            <caption className="visually-hidden">{t("diagnostics.files.heading")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("diagnostics.files.name")}</th>
                <th scope="col">{t("diagnostics.files.size")}</th>
                <th scope="col">{t("diagnostics.files.modified")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("security.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {files.data.map((file) => (
                <tr key={file.name}>
                  <th scope="row">
                    <code translate="no">{file.name}</code> {file.active ? <span>{t("diagnostics.files.active")}</span> : null}
                  </th>
                  <td>{formatByteSize(file.bytes, display.locale)}</td>
                  <td>{formatCell(DATETIME, file.modifiedAt, display)}</td>
                  <td>
                    <a href={logFileDownloadPath(file.name)} download={file.name}>
                      {t("diagnostics.files.download")}
                      <span className="visually-hidden"> {file.name}</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      <p>{t("diagnostics.files.reportHint")}</p>
      <p>
        <a href={REPORT_DOWNLOAD_PATH} download="openlife-diagnostics.json">
          {t("diagnostics.files.report")}
        </a>
      </p>
    </section>
  );
}
