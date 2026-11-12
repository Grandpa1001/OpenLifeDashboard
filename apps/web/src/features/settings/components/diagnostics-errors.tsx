import type { RecentErrorDto } from "@openlife/contracts/http/diagnostics";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { formatCell } from "../../../lib/format/cell-format.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { TableScroll } from "./table-scroll.js";

const DATETIME = { type: "datetime", typeOptions: {} } as const;

/**
 * The latest technical errors of the log (Architektura §15.2, §15.3; D44.6): when, which event and code, and the
 * request they belong to. There is no message: the log holds codes, and the request id leads to the lines of
 * that request in the search below.
 */
export function DiagnosticsErrors({ errors, onFind }: Readonly<{ errors: readonly RecentErrorDto[]; onFind: (requestId: string) => void }>) {
  const { t } = useTranslation("settings");
  const headingId = useId();
  const display = useOwnerDisplay();
  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("diagnostics.errors.heading")}</h2>
      {errors.length === 0 ? (
        <p>{t("diagnostics.errors.none")}</p>
      ) : (
        <TableScroll labelledBy={headingId}>
          <table className="security-table">
            <caption className="visually-hidden">{t("diagnostics.errors.heading")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("diagnostics.errors.when")}</th>
                <th scope="col">{t("diagnostics.errors.event")}</th>
                <th scope="col">{t("diagnostics.errors.code")}</th>
                <th scope="col">{t("diagnostics.errors.request")}</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((error) => (
                <tr key={`${error.at}-${error.event}-${error.requestId ?? ""}`}>
                  <td>{formatCell(DATETIME, error.at, display)}</td>
                  <th scope="row">
                    <code translate="no">{error.event}</code>
                  </th>
                  <td>{error.code === null ? "" : <code translate="no">{error.code}</code>}</td>
                  <td>
                    {error.requestId === null ? null : (
                      <>
                        <code translate="no">{error.requestId}</code>{" "}
                        <button type="button" onClick={() => onFind(error.requestId ?? "")}>
                          {t("diagnostics.errors.find")}
                          <span className="visually-hidden"> {error.requestId}</span>
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}
