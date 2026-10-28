// D18.2 — arranging widgets in the Designer: where a new widget goes in each layout, how a change of
// one layout is written, and how a widget maps to and from the grid library's items.
import type { LayoutDto } from "@openlife/contracts/http/screens";
import { describe, expect, it } from "vitest";
import { applyGridItems, firstFreePlace, fitToColumns, placeInEveryLayout, toGridItems, withLayout } from "../../../apps/web/src/features/dashboard/lib/layout-edit.js";
import { newUuid7 } from "../../../apps/web/src/lib/ids/uuid7.js";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const layoutOf = (phone = rect(0, 0, 1, 4), tablet = rect(0, 0, 4, 4), desktop = rect(0, 0, 6, 4)): LayoutDto => ({ phone, tablet, desktop });
const widget = (id: string, layout: LayoutDto = layoutOf()) => ({ id, type: "register-table", layout });

describe("D18.2 the first free place", () => {
  it("on an empty layout is the top left corner", () => {
    expect(firstFreePlace([], { w: 8, h: 8 }, 12)).toEqual(rect(0, 0, 8, 8));
  });

  it("goes to the right of what holds the top, when the row has room", () => {
    expect(firstFreePlace([rect(0, 0, 4, 4)], { w: 4, h: 4 }, 12)).toEqual(rect(4, 0, 4, 4));
  });

  it("falls to the first row below when the top part is taken across the whole width", () => {
    expect(firstFreePlace([rect(0, 0, 12, 3)], { w: 4, h: 4 }, 12)).toEqual(rect(0, 3, 4, 4));
  });

  it("takes a gap between two widgets when the size fits, and passes it when it does not", () => {
    const around = [rect(0, 0, 4, 4), rect(8, 0, 4, 4)];
    expect(firstFreePlace(around, { w: 4, h: 4 }, 12)).toEqual(rect(4, 0, 4, 4));
    expect(firstFreePlace(around, { w: 5, h: 4 }, 12)).toEqual(rect(0, 4, 5, 4));
  });

  it("finds the free part of a row that a taller widget leaves beside it", () => {
    expect(firstFreePlace([rect(0, 0, 8, 8)], { w: 4, h: 2 }, 12)).toEqual(rect(8, 0, 4, 2));
  });

  it("on the phone is one column wide and stacks below the others", () => {
    expect(firstFreePlace([rect(0, 0, 1, 8)], { w: 8, h: 8 }, 1)).toEqual(rect(0, 8, 1, 8));
  });

  it("narrows a size to the columns of a layout, never below one", () => {
    expect(fitToColumns({ w: 8, h: 8 }, 1)).toEqual({ w: 1, h: 8 });
    expect(fitToColumns({ w: 8, h: 8 }, 8)).toEqual({ w: 8, h: 8 });
    expect(fitToColumns({ w: 8, h: 8 }, 12)).toEqual({ w: 8, h: 8 });
    expect(fitToColumns({ w: 0, h: 3 }, 12)).toEqual({ w: 1, h: 3 });
  });

  it("is found separately in each of the three layouts", () => {
    const placed = placeInEveryLayout([widget("a", layoutOf(rect(0, 0, 1, 8), rect(0, 0, 4, 8), rect(0, 0, 4, 8)))], { w: 8, h: 8 });
    expect(placed).toEqual({ phone: rect(0, 8, 1, 8), tablet: rect(0, 8, 8, 8), desktop: rect(4, 0, 8, 8) });
  });
});

describe("D18.2 a change of one layout", () => {
  it("replaces that layout and leaves the other two as the very same rectangles", () => {
    const before = layoutOf();
    const after = withLayout(before, "desktop", rect(3, 2, 6, 4));
    expect(after.desktop).toEqual(rect(3, 2, 6, 4));
    expect(after.phone).toBe(before.phone);
    expect(after.tablet).toBe(before.tablet);
  });

  it("the items of the grid library are written back into the one layout it showed", () => {
    const widgets = [widget("a"), widget("b", layoutOf(rect(0, 4, 1, 4), rect(4, 0, 4, 4), rect(6, 0, 6, 4)))];
    const next = applyGridItems(widgets, "tablet", [
      { i: "a", x: 2, y: 5, w: 3, h: 6 },
      { i: "b", x: 4, y: 0, w: 4, h: 4 },
    ]);
    expect(next[0]?.layout.tablet).toEqual(rect(2, 5, 3, 6));
    expect(next[0]?.layout.phone).toBe(widgets[0]?.layout.phone);
    expect(next[0]?.layout.desktop).toBe(widgets[0]?.layout.desktop);
    expect(next[1]).toBe(widgets[1]);
  });

  it("returns the very same array when the library reports what is already there", () => {
    const widgets = [widget("a"), widget("b", layoutOf(rect(0, 4, 1, 4), rect(4, 0, 4, 4), rect(6, 0, 6, 4)))];
    expect(applyGridItems(widgets, "desktop", toGridItems(widgets, "desktop", () => ({ w: 3, h: 4 })))).toBe(widgets);
  });

  it("ignores an item of no widget", () => {
    const widgets = [widget("a")];
    expect(applyGridItems(widgets, "phone", [{ i: "ghost", x: 0, y: 9, w: 1, h: 1 }])).toBe(widgets);
  });
});

describe("D18.2 widgets as items of the grid library", () => {
  it("carry the rectangle of the chosen layout and a minimum narrowed to its columns", () => {
    const widgets = [widget("a", layoutOf(rect(0, 2, 1, 5), rect(1, 2, 4, 5), rect(2, 2, 6, 5)))];
    const minimum = () => ({ w: 3, h: 4 });
    expect(toGridItems(widgets, "phone", minimum)).toEqual([{ i: "a", x: 0, y: 2, w: 1, h: 5, minW: 1, minH: 4 }]);
    expect(toGridItems(widgets, "tablet", minimum)).toEqual([{ i: "a", x: 1, y: 2, w: 4, h: 5, minW: 3, minH: 4 }]);
    expect(toGridItems(widgets, "desktop", minimum)).toEqual([{ i: "a", x: 2, y: 2, w: 6, h: 5, minW: 3, minH: 4 }]);
  });
});

describe("D18.2 the identifier of a new widget", () => {
  const SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is a UUID version 7 that the contract accepts, with the time in its first 48 bits", () => {
    const at = Date.UTC(2026, 9, 28, 12, 0, 0);
    const id = newUuid7(at);
    expect(id).toMatch(SHAPE);
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(at);
  });

  it("differs from call to call and sorts by time", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newUuid7(1_000)));
    expect(ids.size).toBe(200);
    expect(newUuid7(1_000) < newUuid7(2_000_000)).toBe(true);
    for (const id of ids) expect(id).toMatch(SHAPE);
  });
});
