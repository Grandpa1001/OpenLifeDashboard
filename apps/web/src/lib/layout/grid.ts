// The grid of the screen (Architektura §8.1; D18): 1, 8 and 12 columns, rows of 32 px and a gap of 16 px.
// One layout is chosen by the width of the window, and a widget is placed by its rectangle in that
// layout. The Designer's grid library draws the same numbers, so what is arranged is what is shown.
import { GRID_COLUMNS, LAYOUT_NAMES, type LayoutDto, type LayoutName, type LayoutRectDto } from "@openlife/contracts/http/screens";
import type { CSSProperties } from "react";

export const GRID = { rowHeightPx: 32, gapPx: 16 } as const;

/** The least width of the window for each layout; narrower than the tablet is the phone. A width of 1800 px and more uses the desktop. */
export const BREAKPOINT_MIN_WIDTH: Readonly<Record<LayoutName, number>> = { phone: 0, tablet: 768, desktop: 1280 };

export function breakpointFor(widthPx: number): LayoutName {
  let chosen: LayoutName = "phone";
  for (const name of LAYOUT_NAMES) if (widthPx >= BREAKPOINT_MIN_WIDTH[name]) chosen = name;
  return chosen;
}

export const columnsOf = (layout: LayoutName): number => GRID_COLUMNS[layout];

/** The container: equal columns, rows of a fixed height, the gap between cells. */
export const gridStyle = (layout: LayoutName): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(${columnsOf(layout)}, minmax(0, 1fr))`,
  gridAutoRows: `${GRID.rowHeightPx}px`,
  gap: `${GRID.gapPx}px`,
});

/** The cell of a widget: it starts at its column and row and spans its width and height. */
export const placementStyle = (rect: LayoutRectDto): CSSProperties => ({ gridColumn: `${rect.x + 1} / span ${rect.w}`, gridRow: `${rect.y + 1} / span ${rect.h}` });

/** The widgets in reading order for one layout: by row, then by column. */
export function readingOrder<T extends Readonly<{ layout: LayoutDto }>>(widgets: readonly T[], layout: LayoutName): readonly T[] {
  return [...widgets].sort((a, b) => a.layout[layout].y - b.layout[layout].y || a.layout[layout].x - b.layout[layout].x);
}
