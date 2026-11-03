import type { ScreenDto } from "@openlife/contracts/http/screens";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { formatCell } from "../../../lib/format/cell-format.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { useOwnerDisplay } from "../../../lib/session/use-owner-display.js";
import { leavesTheGate, readFirstScreen, ScreenFailure } from "../api/first-screen.js";
import { ScreenPropertiesDialog } from "../components/screen-properties-dialog.js";

const DATETIME = { type: "datetime", typeOptions: {} } as const;

/**
 * Pulpity `/screens` (Scope §5.3, makiety 30, 49; D33.1): the one screen of the MVP with its name and
 * its last change, opened to view (`/`) or to edit (`/designer`); Właściwości rename it. With no
 * screen yet the Designer is where it is made.
 */
export function ScreensPage() {
  const { t } = useTranslation("designer");
  const display = useOwnerDisplay();
  const screen = useQuery<ScreenDto | null>({ queryKey: queryKeys.screens.list, queryFn: ({ signal }) => readFirstScreen(signal) });
  const failure = screen.error instanceof ScreenFailure ? screen.error.failure : null;
  const [gateLost, setGateLost] = useState(false);
  useGuardRecheck(gateLost || leavesTheGate(failure));
  const [editing, setEditing] = useState(false);
  const properties = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  // The focus goes back to Właściwości once the window is gone.
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      properties.current?.focus();
    }
  }, [editing]);

  const data = screen.data;
  return (
    <main className="page page-wide">
      <h1>{t("screens.title")}</h1>
      {screen.isPending ? <p role="status">{t("screens.loading")}</p> : null}
      {failure === null ? null : (
        <>
          <FailureAlert message={describeFailure(failure)} />
          <button type="button" onClick={() => void screen.refetch()}>
            {t("retry")}
          </button>
        </>
      )}
      {data === null ? (
        <section className="card" aria-labelledby="screens-empty">
          <h2 id="screens-empty">{t("screens.emptyHeading")}</h2>
          <p>{t("screens.empty")}</p>
          <Link to="/designer">{t("screens.openDesigner")}</Link>
        </section>
      ) : null}
      {data === undefined || data === null ? null : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t("screens.title")}>
          <table className="screens-table">
            <caption className="visually-hidden">{t("screens.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("screens.name")}</th>
                <th scope="col">{t("screens.updatedAt")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("screens.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{data.name}</th>
                <td>
                  <time dateTime={data.updatedAt}>{formatCell(DATETIME, data.updatedAt, display)}</time>
                </td>
                <td className="screens-actions">
                  <Link to="/">{t("screens.view")}</Link>
                  <Link to="/designer">{t("screens.edit")}</Link>
                  <button ref={properties} type="button" className="link-button" onClick={() => setEditing(true)}>
                    {t("screens.properties.open")}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {editing && data !== undefined && data !== null ? (
        <ScreenPropertiesDialog
          screen={data}
          onGateLost={() => setGateLost(true)}
          onClose={() => {
            returnFocus.current = true;
            setEditing(false);
          }}
        />
      ) : null}
    </main>
  );
}
