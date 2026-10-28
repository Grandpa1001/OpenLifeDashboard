// Arranging widgets on the grids of the Designer (Architektura §8.1; D18.2). Pure functions: the
// grid library only draws and moves, and these decide where a widget starts, how a change of one
// layout is written and how a widget maps to and from the library's items. The three layouts of a
// widget are independent: what is arranged in one never moves another.
import { GRID_COLUMNS, type LayoutDto, type LayoutName, type LayoutRectDto } from "@openlife/contracts/http/screens";

export type Size = Readonly<{ w: number; h: number }>;

/** The size narrowed to the columns of a layout: a table of 8 columns on the phone is one column wide. */
export const fitToColumns = (size: Size, columns: number): Size => ({ w: Math.max(1, Math.min(size.w, columns)), h: size.h });

const overlaps = (a: LayoutRectDto, b: LayoutRectDto): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The first place from the top, then from the left, where a rectangle of the size fits among the occupied ones. */
export function firstFreePlace(occupied: readonly LayoutRectDto[], size: Size, columns: number): LayoutRectDto {
  const { w, h } = fitToColumns(size, columns);
  const bottom = occupied.reduce((lowest, rect) => Math.max(lowest, rect.y + rect.h), 0);
  for (let y = 0; y <= bottom; y += 1) {
    for (let x = 0; x + w <= columns; x += 1) {
      const candidate = { x, y, w, h };
      if (!occupied.some((rect) => overlaps(rect, candidate))) return candidate;
    }
  }
  return { x: 0, y: bottom, w, h };
}

/** The place of a new widget in each of the three layouts, found separately in each. */
export function placeInEveryLayout(existing: readonly Readonly<{ layout: LayoutDto }>[], size: Size): LayoutDto {
  const place = (name: LayoutName): LayoutRectDto => firstFreePlace(existing.map((widget) => widget.layout[name]), size, GRID_COLUMNS[name]);
  return { phone: place("phone"), tablet: place("tablet"), desktop: place("desktop") };
}

/** One layout of a widget replaced; the other two are the very same rectangles. */
export const withLayout = (layout: LayoutDto, name: LayoutName, rect: LayoutRectDto): LayoutDto => ({ ...layout, [name]: rect });

export const sameRect = (a: LayoutRectDto, b: LayoutRectDto): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** An item as the grid library takes it (`i` is the key of the child). */
export type GridItem = Readonly<{ i: string; x: number; y: number; w: number; h: number; minW: number; minH: number }>;
type Placed = Readonly<{ id: string; type: string; layout: LayoutDto }>;

/** The widgets as items of one layout, each with the smallest size its type allows in that layout. */
export function toGridItems(widgets: readonly Placed[], name: LayoutName, minimumOf: (type: string) => Size): GridItem[] {
  const columns = GRID_COLUMNS[name];
  return widgets.map((widget) => {
    const { x, y, w, h } = widget.layout[name];
    const minimum = fitToColumns(minimumOf(widget.type), columns);
    return { i: widget.id, x, y, w, h, minW: minimum.w, minH: minimum.h };
  });
}

/**
 * What the grid library returned, written back into the one layout it showed. A widget whose
 * rectangle did not change keeps its object, and when nothing changed the very same array comes
 * back, so a library that reports its layout after it mounted does not make a change.
 */
export function applyGridItems<W extends Placed>(widgets: readonly W[], name: LayoutName, items: readonly Readonly<{ i: string; x: number; y: number; w: number; h: number }>[]): readonly W[] {
  let changed = false;
  const next = widgets.map((widget) => {
    const item = items.find((candidate) => candidate.i === widget.id);
    if (item === undefined) return widget;
    const rect: LayoutRectDto = { x: item.x, y: item.y, w: item.w, h: item.h };
    if (sameRect(rect, widget.layout[name])) return widget;
    changed = true;
    return { ...widget, layout: withLayout(widget.layout, name, rect) };
  });
  return changed ? next : widgets;
}
