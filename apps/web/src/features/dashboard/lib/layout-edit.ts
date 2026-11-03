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

/** A copy of a widget: in each layout its own size, at the first free place there among the others (D34.1). */
export function placeCopy(existing: readonly Readonly<{ layout: LayoutDto }>[], original: LayoutDto): LayoutDto {
  const place = (name: LayoutName): LayoutRectDto => firstFreePlace(existing.map((widget) => widget.layout[name]), original[name], GRID_COLUMNS[name]);
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

/** A rectangle of one widget in one layout. */
export type Placement = Readonly<{ id: string; rect: LayoutRectDto }>;

/** The rectangle kept inside the columns of the layout and at least the minimum of its type there (Scope §5.4). */
export function withinGrid(rect: LayoutRectDto, columns: number, minimum: Size): LayoutRectDto {
  const least = fitToColumns(minimum, columns);
  const w = Math.min(Math.max(rect.w, least.w), columns);
  const h = Math.max(rect.h, least.h);
  return { x: Math.min(Math.max(rect.x, 0), columns - w), y: Math.max(rect.y, 0), w, h };
}

/**
 * One widget put at `target` in one layout (D33.2): the target kept within the grid and the minimum,
 * then every widget it would overlap moved down just below it, and every widget those would overlap
 * in turn. Nothing moves up and no gap is closed, so the rest of the layout stays where the owner put
 * it. The one rule of the mouse, the touch and the keyboard.
 */
export function placeWithCollisions(placements: readonly Placement[], id: string, target: LayoutRectDto, columns: number, minimum: Size): Placement[] {
  const rects = new Map(placements.map((each) => [each.id, each.rect]));
  if (!rects.has(id)) return [...placements];
  rects.set(id, withinGrid(target, columns, minimum));
  const pending = [id];
  while (pending.length > 0) {
    const mover = pending.shift()!;
    const above = rects.get(mover)!;
    // The widgets hit, from the top, so a chain is pushed in the order it is stacked.
    const hit = [...rects.entries()].filter(([other, rect]) => other !== mover && other !== id && overlaps(above, rect)).sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
    for (const [other, rect] of hit) {
      rects.set(other, { ...rect, y: above.y + above.h });
      pending.push(other);
    }
  }
  return placements.map((each) => ({ id: each.id, rect: rects.get(each.id)! }));
}

export type Nudge = "left" | "right" | "up" | "down";

/** Alt + arrow moves by one unit of the grid; Alt + Shift + arrow makes it one unit wider, narrower, taller or shorter. */
export function nudged(rect: LayoutRectDto, direction: Nudge, resize: boolean): LayoutRectDto {
  const dx = direction === "left" ? -1 : direction === "right" ? 1 : 0;
  const dy = direction === "up" ? -1 : direction === "down" ? 1 : 0;
  return resize ? { ...rect, w: rect.w + dx, h: rect.h + dy } : { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/** The widgets with one layout placed by `placeWithCollisions`; the other two layouts are the very same rectangles. */
export function placeInLayout<W extends Placed>(widgets: readonly W[], name: LayoutName, id: string, target: LayoutRectDto, minimum: Size): readonly W[] {
  const placed = placeWithCollisions(
    widgets.map((widget) => ({ id: widget.id, rect: widget.layout[name] })),
    id,
    target,
    GRID_COLUMNS[name],
    minimum,
  );
  return applyGridItems(
    widgets,
    name,
    placed.map(({ id: each, rect }) => ({ i: each, ...rect })),
  );
}
