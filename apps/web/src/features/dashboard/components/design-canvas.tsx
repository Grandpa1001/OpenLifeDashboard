import type { RegistryDto } from "@openlife/contracts/http/registries";
import { GRID_COLUMNS, type LayoutName, type LayoutRectDto, type WidgetDesignDto } from "@openlife/contracts/http/screens";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactGridLayout, { type LayoutItem, type ResizeHandleAxis } from "react-grid-layout";
import { noCompactor } from "react-grid-layout/core";
import "react-grid-layout/css/styles.css";
import { useTranslation } from "react-i18next";
import { GRID } from "../../../lib/layout/grid.js";
import { nudged, toGridItems, type Nudge, type Size } from "../lib/layout-edit.js";
import { OWNER_ZONE } from "@openlife/widgets/views";
import { choiceOf } from "../lib/register-table-bindings.js";
import { typeLabelKey } from "../lib/type-label.js";

/** Only the title of a card moves it, so a click inside never drags; the corner resizes. */
const HANDLE_SELECTOR = ".designer-handle";
const RESIZE_HANDLES: ResizeHandleAxis[] = ["se"];

const ARROWS: Readonly<Record<string, Nudge>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

const rectOf = (item: LayoutItem): LayoutRectDto => ({ x: item.x, y: item.y, w: item.w, h: item.h });

/**
 * One layout of the screen drawn on its grid (Scope §5.4; D18.2, D33.2). The grid library draws the
 * drag and the resize of a card; where the card lands is decided by `placeWithCollisions` (through
 * `onPlace`), the same rule as Alt + arrow on the keyboard, so neighbours are pushed down and nothing
 * goes below the minimum or out of the columns. The title bar is the handle; Escape during a drag
 * takes the card back, otherwise it lets go of the selection. The cards show what the widget is bound
 * to, not its data (the preview with sample data is D39).
 */
export function DesignCanvas({
  layout,
  width,
  widgets,
  registries,
  selectedId,
  minimumOf,
  onSelect,
  onArranging,
  onPlace,
}: Readonly<{
  layout: LayoutName;
  /** The width the layout is drawn at, in pixels. */
  width: number;
  widgets: readonly WidgetDesignDto[];
  registries: readonly RegistryDto[];
  selectedId: string | null;
  minimumOf: (type: string) => Size;
  onSelect: (id: string | null) => void;
  /** A drag or a resize begins (`true`) or ends, by a drop or by Escape (`false`). */
  onArranging: (arranging: boolean) => void;
  onPlace: (id: string, rect: LayoutRectDto) => void;
}>) {
  const { t } = useTranslation("designer");
  const { t: tw } = useTranslation("widgets");
  const label = t(`toolbar.${layout}`);
  // A drag or a resize in progress; Escape draws the grid anew, which drops it, and its end is not a place.
  const moving = useRef(false);
  const arrange = (arranging: boolean): void => {
    moving.current = arranging;
    onArranging(arranging);
  };
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || !moving.current) return;
      arrange(false);
      setGeneration((each) => each + 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  /** What a tile says of its widget: the zone of a clock, the registry and the columns of a table. */
  function summaryOf(widget: WidgetDesignDto): string {
    if (widget.type === "clock") {
      const zone = widget.config["timezone"];
      return typeof zone === "string" && zone !== OWNER_ZONE ? zone : t("clock.ownerZone");
    }
    const choice = choiceOf(widget.bindings);
    const registry = registries.find((candidate) => candidate.id === choice.registryId);
    return registry === undefined ? t("canvas.unbound") : t("canvas.bound", { registry: registry.symbol, columns: choice.columnKeys.length });
  }

  function landed(item: LayoutItem | null): void {
    if (!moving.current) return;
    arrange(false);
    if (item !== null) onPlace(item.i, rectOf(item));
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, widget: WidgetDesignDto): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onSelect(null);
      return;
    }
    const direction = ARROWS[event.key];
    if (!event.altKey || direction === undefined) return;
    event.preventDefault();
    if (widget.id !== selectedId) onSelect(widget.id);
    onPlace(widget.id, nudged(widget.layout[layout], direction, event.shiftKey));
  }

  return (
    <div className="designer-stage">
      <div className="designer-frame" style={{ width }} role="group" aria-label={t("canvas.label", { layout: label })} data-layout={layout} tabIndex={-1}>
        {widgets.length === 0 ? <p className="designer-empty">{t("canvas.empty")}</p> : null}
        <p id="designer-keys" className="visually-hidden">
          {t("canvas.keys")}
        </p>
        <ReactGridLayout
          key={generation}
          layout={toGridItems(widgets, layout, minimumOf)}
          width={width}
          gridConfig={{ cols: GRID_COLUMNS[layout], rowHeight: GRID.rowHeightPx, margin: [GRID.gapPx, GRID.gapPx], containerPadding: [0, 0] }}
          dragConfig={{ handle: HANDLE_SELECTOR }}
          resizeConfig={{ handles: RESIZE_HANDLES }}
          compactor={noCompactor}
          onDragStart={(_layout, _old, item) => {
            arrange(true);
            if (item !== null && item.i !== selectedId) onSelect(item.i);
          }}
          onResizeStart={() => arrange(true)}
          onDragStop={(_layout, _old, item) => landed(item)}
          onResizeStop={(_layout, _old, item) => landed(item)}
        >
          {widgets.map((widget) => {
            const config = widget.config;
            // A table is named by its title, a clock by its caption, either by its type when it has none.
            const named = [config["title"], config["label"]].find((each): each is string => typeof each === "string" && each !== "");
            const title = named ?? tw(typeLabelKey(widget.type));
            const selected = widget.id === selectedId;
            return (
              <div key={widget.id} className={selected ? "designer-widget selected" : "designer-widget"} data-widget-id={widget.id}>
                <button
                  type="button"
                  className="designer-handle"
                  aria-pressed={selected}
                  aria-label={t("canvas.select", { name: title })}
                  aria-describedby="designer-keys"
                  // A touch on the bar starts a drag, which keeps the click from coming: the press selects.
                  onPointerDown={() => onSelect(widget.id)}
                  onClick={() => onSelect(widget.id)}
                  onKeyDown={(event) => onKeyDown(event, widget)}
                >
                  {title}
                </button>
                <p className="designer-summary">{summaryOf(widget)}</p>
              </div>
            );
          })}
        </ReactGridLayout>
      </div>
    </div>
  );
}
