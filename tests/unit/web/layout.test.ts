// D18.1 — the grid of the screen: which layout a width calls for, and where a rectangle puts a
// widget. The Designer's grid library draws these same numbers, so the arithmetic is held here.
import { describe, expect, it } from "vitest";
import { BREAKPOINT_MIN_WIDTH, breakpointFor, columnsOf, GRID, gridStyle, placementStyle, readingOrder } from "../../../apps/web/src/lib/layout/grid.js";

describe("D18.1 the layout a width calls for", () => {
  it("below 768 px is the phone, 768 to 1279 the tablet, 1280 and more the desktop, the large screen included", () => {
    const cases: Array<[number, "phone" | "tablet" | "desktop"]> = [[0, "phone"], [320, "phone"], [375, "phone"], [767, "phone"], [767.9, "phone"], [768, "tablet"], [1024, "tablet"], [1279, "tablet"], [1279.9, "tablet"], [1280, "desktop"], [1440, "desktop"], [1799, "desktop"], [1800, "desktop"], [3840, "desktop"]];
    for (const [width, expected] of cases) expect(breakpointFor(width), String(width)).toBe(expected);
    expect(BREAKPOINT_MIN_WIDTH).toEqual({ phone: 0, tablet: 768, desktop: 1280 });
  });

  it("a width that is no width is the phone, never a crash", () => {
    for (const width of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) expect(breakpointFor(width), String(width)).toBe("phone");
    expect(breakpointFor(Number.POSITIVE_INFINITY)).toBe("desktop");
  });

  it("the grid has 1, 8 and 12 columns, rows of 32 px and a gap of 16 px", () => {
    expect([columnsOf("phone"), columnsOf("tablet"), columnsOf("desktop")]).toEqual([1, 8, 12]);
    expect(GRID).toEqual({ rowHeightPx: 32, gapPx: 16 });
    expect(gridStyle("desktop")).toEqual({ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gridAutoRows: "32px", gap: "16px" });
    expect(gridStyle("phone").gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
  });
});

describe("D18.1 where a rectangle puts a widget", () => {
  it("it starts at its column and row (one-based) and spans its width and height", () => {
    expect(placementStyle({ x: 0, y: 0, w: 8, h: 8 })).toEqual({ gridColumn: "1 / span 8", gridRow: "1 / span 8" });
    expect(placementStyle({ x: 8, y: 3, w: 4, h: 3 })).toEqual({ gridColumn: "9 / span 4", gridRow: "4 / span 3" });
    expect(placementStyle({ x: 0, y: 11, w: 1, h: 3 })).toEqual({ gridColumn: "1 / span 1", gridRow: "12 / span 3" });
  });

  it("widgets are read by row and then by column in the layout asked for, and the order of another layout does not matter", () => {
    const rect = (x: number, y: number) => ({ x, y, w: 2, h: 2 });
    const widget = (id: string, phone: [number, number], desktop: [number, number]) => ({ id, layout: { phone: rect(...phone), tablet: rect(...phone), desktop: rect(...desktop) } });
    const widgets = [widget("a", [0, 8], [6, 0]), widget("b", [0, 0], [0, 4]), widget("c", [0, 4], [0, 0])];
    expect(readingOrder(widgets, "phone").map((each) => each.id)).toEqual(["b", "c", "a"]);
    expect(readingOrder(widgets, "desktop").map((each) => each.id)).toEqual(["c", "a", "b"]);
    expect(widgets.map((each) => each.id)).toEqual(["a", "b", "c"]);
  });
});
