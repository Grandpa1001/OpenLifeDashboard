import type { ScreenDto } from "@openlife/contracts/http/screens";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { describeFailure } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { useBreakpoint } from "../../../lib/layout/use-breakpoint.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { useScreenAccent } from "../../../lib/theme/screen-accent.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { leavesTheGate, readFirstScreen, ScreenFailure } from "../api/first-screen.js";
import { useLayoutRefreshedNotice } from "../lib/refreshed-notice.js";
import type { AddRecordRenderer } from "../components/register-table-widget.js";
import { ScreenGrid } from "../components/screen-grid.js";

/** The way into the part of the application: a grid of four squares, its name for the reader and the hover. */
function OpenAppIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * The screen of the owner under `/` (Scope §5.3; D33.1): only the widgets of the screen on the grid of
 * the layout the window calls for. It has no bar; its one control is the icon that opens the part of
 * the application.
 */
export function MainPage({ renderAddRecord }: Readonly<{ renderAddRecord: AddRecordRenderer }>) {
  const { t } = useTranslation(["common", "designer"]);
  const layout = useBreakpoint();

  const screen = useQuery<ScreenDto | null>({ queryKey: queryKeys.screens.list, queryFn: ({ signal }) => readFirstScreen(signal) });
  useScreenAccent(screen.data?.accent);
  const refreshed = useLayoutRefreshedNotice(screen.data);
  const failure = screen.error instanceof ScreenFailure ? screen.error.failure : null;
  const gone = leavesTheGate(failure);
  useGuardRecheck(gone);

  const widgets = screen.data === undefined || screen.data === null ? [] : screen.data.widgets;
  return (
    <main className="page page-wide pulpit">
      <h1 className="visually-hidden">{t("main.title")}</h1>
      <Link to="/screens" className="open-app" aria-label={t("main.openApp")} title={t("main.openApp")}>
        <OpenAppIcon />
      </Link>
      {screen.isPending ? <p role="status">{t("main.loading")}</p> : null}
      {refreshed ? (
        <p role="status" className="layout-refreshed">
          {t("elsewhere.refreshed", { ns: "designer" })}
        </p>
      ) : null}
      {failure === null ? null : (
        <>
          <FailureAlert message={describeFailure(failure)} />
          <button type="button" onClick={() => void screen.refetch()}>
            {t("main.retry")}
          </button>
        </>
      )}
      {screen.data !== undefined && widgets.length === 0 ? (
        <section className="card" aria-labelledby="main-empty">
          <h2 id="main-empty">{t("main.emptyHeading")}</h2>
          <p>{t("main.empty")}</p>
          <Link to="/designer">{t("main.openDesigner")}</Link>
        </section>
      ) : null}
      {widgets.length === 0 ? null : <ScreenGrid widgets={widgets} layout={layout} renderAddRecord={renderAddRecord} />}
    </main>
  );
}
