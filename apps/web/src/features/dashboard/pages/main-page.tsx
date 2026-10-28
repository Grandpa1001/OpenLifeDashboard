import type { ScreenDto, WidgetViewDto } from "@openlife/contracts/http/screens";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { WidgetBoundary } from "../../../lib/boundary/widget-boundary.js";
import { describeFailure, type ErrorMessage } from "../../../lib/failures/error-message.js";
import { FailureAlert } from "../../../lib/failures/failure-alert.js";
import { gridStyle, placementStyle, readingOrder } from "../../../lib/layout/grid.js";
import { useBreakpoint } from "../../../lib/layout/use-breakpoint.js";
import { queryKeys } from "../../../lib/query-keys/index.js";
import { endSession } from "../../../lib/session/end-session.js";
import { useGuardRecheck } from "../../../lib/session/use-guard-recheck.js";
import { leavesTheGate, readFirstScreen, ScreenFailure } from "../api/first-screen.js";
import { typeLabelKey } from "../lib/type-label.js";
import { RegisterTableWidget, type AddRecordRenderer } from "../components/register-table-widget.js";

function WidgetCell({ widget, layout, renderAddRecord }: Readonly<{ widget: WidgetViewDto; layout: ReturnType<typeof useBreakpoint>; renderAddRecord: AddRecordRenderer }>) {
  const { t } = useTranslation("widgets");
  const title = typeof widget.config["title"] === "string" ? widget.config["title"] : "";
  const headingId = `widget-${widget.id}`;
  return (
    <section className="card widget" style={placementStyle(widget.layout[layout])} aria-labelledby={title === "" ? undefined : headingId} aria-label={title === "" ? t(typeLabelKey(widget.type)) : undefined}>
      {title === "" ? null : <h2 id={headingId}>{title}</h2>}
      <WidgetBoundary
        fallback={(reset) => (
          <div className="widget-state" data-state="crashed">
            <p role="alert">{t("crashed")}</p>
            <button type="button" onClick={reset}>
              {t("registerTable.retry")}
            </button>
          </div>
        )}
      >
        {widget.type === "register-table" ? (
          <RegisterTableWidget widget={widget} renderAddRecord={renderAddRecord} />
        ) : (
          <p role="status">{t("unsupported")}</p>
        )}
      </WidgetBoundary>
    </section>
  );
}

/** The private screen (Scope §5.3): the widgets of the screen on the grid of the layout the window calls for. */
export function MainPage({ renderAddRecord }: Readonly<{ renderAddRecord: AddRecordRenderer }>) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const layout = useBreakpoint();
  const [problem, setProblem] = useState<ErrorMessage | null>(null);

  const screen = useQuery<ScreenDto | null>({ queryKey: queryKeys.screens.list, queryFn: ({ signal }) => readFirstScreen(signal) });
  const failure = screen.error instanceof ScreenFailure ? screen.error.failure : null;
  const gone = leavesTheGate(failure);
  useGuardRecheck(gone);

  async function leave(): Promise<void> {
    setProblem(null);
    const result = await endSession(queryClient);
    if (!result.ok && result.failure.kind !== "aborted") {
      setProblem(describeFailure(result.failure));
      return;
    }
    await navigate({ to: "/login" });
  }

  const widgets = screen.data === undefined || screen.data === null ? [] : readingOrder(screen.data.widgets, layout);
  return (
    <main className="page page-wide">
      <h1>{t("main.title")}</h1>
      {screen.data === undefined || screen.data === null ? null : <p className="screen-name">{screen.data.name}</p>}
      <nav aria-label={t("main.navigation")} className="topbar">
        <Link to="/designer">{t("main.designer")}</Link>
        <Link to="/registers">{t("main.registers")}</Link>
        <button type="button" onClick={() => void leave()}>
          {t("main.signOut")}
        </button>
      </nav>
      {problem === null ? null : <FailureAlert message={problem} />}
      {screen.isPending ? <p role="status">{t("main.loading")}</p> : null}
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
      {widgets.length === 0 ? null : (
        <div className="screen-grid" style={gridStyle(layout)} data-layout={layout}>
          {widgets.map((widget) => (
            <WidgetCell key={widget.id} widget={widget} layout={layout} renderAddRecord={renderAddRecord} />
          ))}
        </div>
      )}
    </main>
  );
}
