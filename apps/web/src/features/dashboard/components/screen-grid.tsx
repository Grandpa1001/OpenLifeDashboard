import type { LayoutName, WidgetViewDto } from "@openlife/contracts/http/screens";
import { useTranslation } from "react-i18next";
import { WidgetBoundary } from "../../../lib/boundary/widget-boundary.js";
import { gridStyle, placementStyle, readingOrder } from "../../../lib/layout/grid.js";
import { typeLabelKey } from "../lib/type-label.js";
import { ClockWidget } from "./clock-widget.js";
import { RegisterTableWidget, type AddRecordRenderer } from "./register-table-widget.js";

function WidgetCell({ widget, layout, renderAddRecord, preview }: Readonly<{ widget: WidgetViewDto; layout: LayoutName; renderAddRecord: AddRecordRenderer; preview: boolean }>) {
  const { t } = useTranslation("widgets");
  const title = typeof widget.config["title"] === "string" ? widget.config["title"] : "";
  const headingId = `widget-${widget.id}`;
  // A clock has a caption instead of a title; its view shows it, so it names the region without a heading.
  const caption = typeof widget.config["label"] === "string" && widget.config["label"] !== "" ? `${t(typeLabelKey(widget.type))}: ${widget.config["label"]}` : t(typeLabelKey(widget.type));
  return (
    <section className="card widget" style={placementStyle(widget.layout[layout])} aria-labelledby={title === "" ? undefined : headingId} aria-label={title === "" ? caption : undefined}>
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
          <RegisterTableWidget widget={widget} renderAddRecord={renderAddRecord} preview={preview} />
        ) : widget.type === "clock" ? (
          <ClockWidget widget={widget} />
        ) : (
          <p role="status">{t("unsupported")}</p>
        )}
      </WidgetBoundary>
    </section>
  );
}

/**
 * The widgets of a screen on the grid of one layout (Scope §5.3; D33.1, D39.3): the same cells on the
 * dashboard and in the preview of the Designer, so the preview cannot show what the dashboard would not.
 * Only in the preview a widget with an unbound slot shows the sample data of its type.
 */
export function ScreenGrid({ widgets, layout, renderAddRecord, preview = false }: Readonly<{ widgets: readonly WidgetViewDto[]; layout: LayoutName; renderAddRecord: AddRecordRenderer; preview?: boolean }>) {
  return (
    <div className="screen-grid" style={gridStyle(layout)} data-layout={layout}>
      {readingOrder(widgets, layout).map((widget) => (
        <WidgetCell key={widget.id} widget={widget} layout={layout} renderAddRecord={renderAddRecord} preview={preview} />
      ))}
    </div>
  );
}
