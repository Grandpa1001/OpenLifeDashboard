import type { RegistryDto } from "@openlife/contracts/http/registries";
import { GRID_COLUMNS, type LayoutName, type WidgetDesignDto } from "@openlife/contracts/http/screens";
import ReactGridLayout, { type ResizeHandleAxis } from "react-grid-layout";
import { noCompactor } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import { useTranslation } from "react-i18next";
import { GRID } from "../../../lib/layout/grid.js";
import { toGridItems, type Size } from "../lib/layout-edit.js";
import { choiceOf } from "../lib/register-table-bindings.js";
import { PREVIEW_WIDTH_PX } from "../lib/preview-width.js";
import { typeLabelKey } from "../lib/type-label.js";

/** Only the title of a card moves it, so a click inside never drags; the corner resizes. */
const HANDLE_SELECTOR = ".designer-handle";
const RESIZE_HANDLES: ResizeHandleAxis[] = ["se"];

export type ArrangedItems = readonly Readonly<{ i: string; x: number; y: number; w: number; h: number }>[];

/**
 * One layout of the screen drawn on its grid (Scope §5.4). The grid library moves and resizes the
 * cards; what it reports when the owner lets go is written into this layout only. The cards show
 * what the widget is bound to, not its data (the preview with sample data is D39).
 */
export function DesignCanvas({
  layout,
  widgets,
  registries,
  selectedId,
  minimumOf,
  onSelect,
  onArranged,
}: Readonly<{
  layout: LayoutName;
  widgets: readonly WidgetDesignDto[];
  registries: readonly RegistryDto[];
  selectedId: string | null;
  minimumOf: (type: string) => Size;
  onSelect: (id: string) => void;
  onArranged: (items: ArrangedItems) => void;
}>) {
  const { t } = useTranslation("designer");
  const { t: tw } = useTranslation("widgets");
  const label = t(`toolbar.${layout}`);

  return (
    <div className="designer-stage">
      <div className="designer-frame" style={{ width: PREVIEW_WIDTH_PX[layout] }} role="group" aria-label={t("canvas.label", { layout: label })} data-layout={layout}>
        {widgets.length === 0 ? <p className="designer-empty">{t("canvas.empty")}</p> : null}
        <ReactGridLayout
          layout={toGridItems(widgets, layout, minimumOf)}
          width={PREVIEW_WIDTH_PX[layout]}
          gridConfig={{ cols: GRID_COLUMNS[layout], rowHeight: GRID.rowHeightPx, margin: [GRID.gapPx, GRID.gapPx], containerPadding: [0, 0] }}
          dragConfig={{ handle: HANDLE_SELECTOR }}
          resizeConfig={{ handles: RESIZE_HANDLES }}
          compactor={noCompactor}
          onDragStop={(items) => onArranged(items)}
          onResizeStop={(items) => onArranged(items)}
        >
          {widgets.map((widget) => {
            const config = widget.config;
            const title = typeof config["title"] === "string" && config["title"] !== "" ? config["title"] : tw(typeLabelKey(widget.type));
            const choice = choiceOf(widget.bindings);
            const registry = registries.find((candidate) => candidate.id === choice.registryId);
            const selected = widget.id === selectedId;
            return (
              <div key={widget.id} className={selected ? "designer-widget selected" : "designer-widget"} data-widget-id={widget.id}>
                <button type="button" className="designer-handle" aria-pressed={selected} aria-label={t("canvas.select", { name: title })} onClick={() => onSelect(widget.id)}>
                  {title}
                </button>
                <p className="designer-summary">{registry === undefined ? t("canvas.unbound") : t("canvas.bound", { registry: registry.symbol, columns: choice.columnKeys.length })}</p>
              </div>
            );
          })}
        </ReactGridLayout>
      </div>
    </div>
  );
}
