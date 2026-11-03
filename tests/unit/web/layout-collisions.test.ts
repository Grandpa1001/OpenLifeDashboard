// D33.2 — the one rule of the grid for the mouse, the touch and the keyboard (Scope §5.4,
// Architektura §8.1): a widget put on an occupied place pushes what it would overlap down, in its own
// layout only; nothing goes below the minimum of its type or out of the columns; Alt + arrow moves by
// one unit and Alt + Shift + arrow resizes by one.
import type { LayoutDto } from "@openlife/contracts/http/screens";
import { describe, expect, it } from "vitest";
import { nudged, placeInLayout, placeWithCollisions, withinGrid } from "../../../apps/web/src/features/dashboard/lib/layout-edit.js";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const ONE = { w: 1, h: 1 };
const of = (placed: ReturnType<typeof placeWithCollisions>, id: string) => placed.find((each) => each.id === id)?.rect;

describe("D33.2 a collision pushes the neighbour down", () => {
  it("on the desktop: a widget moved onto another pushes it just below, and one below that in turn; a gap is not closed", () => {
    const placed = placeWithCollisions(
      [
        { id: "a", rect: rect(0, 0, 4, 4) },
        { id: "b", rect: rect(4, 0, 4, 4) },
        { id: "c", rect: rect(4, 5, 4, 3) },
        { id: "d", rect: rect(8, 10, 4, 2) },
      ],
      "a",
      rect(4, 2, 4, 4),
      12,
      ONE,
    );
    expect(of(placed, "a")).toEqual(rect(4, 2, 4, 4));
    expect(of(placed, "b")).toEqual(rect(4, 6, 4, 4));
    expect(of(placed, "c")).toEqual(rect(4, 10, 4, 3));
    // Nothing touched it: it stays, and no gap above it is closed.
    expect(of(placed, "d")).toEqual(rect(8, 10, 4, 2));
  });

  it("on the tablet: a resize over a neighbour pushes it below the new bottom", () => {
    const placed = placeWithCollisions([{ id: "a", rect: rect(0, 0, 4, 4) }, { id: "b", rect: rect(4, 0, 4, 4) }], "a", rect(0, 0, 6, 4), 8, ONE);
    expect(of(placed, "a")).toEqual(rect(0, 0, 6, 4));
    expect(of(placed, "b")).toEqual(rect(4, 4, 4, 4));
  });

  it("on the phone: one column, moving up past the one above swaps them by pushing it down", () => {
    const placed = placeWithCollisions([{ id: "a", rect: rect(0, 0, 1, 6) }, { id: "b", rect: rect(0, 6, 1, 4) }], "b", rect(0, 0, 1, 4), 1, ONE);
    expect(of(placed, "b")).toEqual(rect(0, 0, 1, 4));
    expect(of(placed, "a")).toEqual(rect(0, 4, 1, 6));
  });

  it("a place that overlaps nothing moves no one, and the result never has two widgets overlapping", () => {
    const start = [
      { id: "a", rect: rect(0, 0, 3, 3) },
      { id: "b", rect: rect(3, 0, 3, 3) },
      { id: "c", rect: rect(0, 3, 6, 2) },
      { id: "d", rect: rect(6, 0, 6, 6) },
    ];
    expect(placeWithCollisions(start, "a", rect(0, 8, 3, 3), 12, ONE).filter((each) => each.id !== "a")).toEqual(start.filter((each) => each.id !== "a"));
    for (const target of [rect(2, 1, 6, 4), rect(5, 0, 4, 2), rect(0, 2, 12, 2), rect(4, 4, 8, 8)]) {
      const placed = placeWithCollisions(start, "a", target, 12, ONE);
      for (const one of placed)
        for (const other of placed)
          if (one.id < other.id) {
            const [p, q] = [one.rect, other.rect];
            expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, `${one.id} and ${other.id} at ${JSON.stringify(target)}`).toBe(false);
          }
    }
  });
});

describe("D33.2 the minimum and the columns", () => {
  it("nothing is smaller than the minimum of its type, nor wider than the columns, nor outside them", () => {
    expect(withinGrid(rect(0, 0, 2, 2), 12, { w: 4, h: 6 })).toEqual(rect(0, 0, 4, 6));
    expect(withinGrid(rect(10, 0, 4, 4), 12, ONE)).toEqual(rect(8, 0, 4, 4));
    expect(withinGrid(rect(-1, -3, 20, 4), 8, ONE)).toEqual(rect(0, 0, 8, 4));
    // On the phone the minimum is narrowed to its one column.
    expect(withinGrid(rect(0, 0, 1, 2), 1, { w: 4, h: 6 })).toEqual(rect(0, 0, 1, 6));
  });

  it("a shrink stops at the minimum and a move stops at the edge", () => {
    const at = rect(0, 0, 4, 6);
    const shrunk = placeWithCollisions([{ id: "a", rect: at }], "a", nudged(at, "left", true), 12, { w: 4, h: 6 });
    expect(of(shrunk, "a")).toEqual(at);
    const left = placeWithCollisions([{ id: "a", rect: at }], "a", nudged(at, "left", false), 12, ONE);
    expect(of(left, "a")).toEqual(at);
    const up = placeWithCollisions([{ id: "a", rect: at }], "a", nudged(at, "up", false), 12, ONE);
    expect(of(up, "a")).toEqual(at);
  });
});

describe("D33.2 the keyboard", () => {
  it("Alt + arrow moves by one unit, Alt + Shift + arrow resizes by one", () => {
    const at = rect(2, 3, 4, 5);
    expect(nudged(at, "right", false)).toEqual(rect(3, 3, 4, 5));
    expect(nudged(at, "down", false)).toEqual(rect(2, 4, 4, 5));
    expect(nudged(at, "right", true)).toEqual(rect(2, 3, 5, 5));
    expect(nudged(at, "up", true)).toEqual(rect(2, 3, 4, 4));
  });
});

describe("D33.2 one layout at a time", () => {
  it("a move with a collision in one layout leaves the other two layouts of every widget as they were", () => {
    const a: LayoutDto = { phone: rect(0, 0, 1, 4), tablet: rect(0, 0, 4, 4), desktop: rect(0, 0, 4, 4) };
    const b: LayoutDto = { phone: rect(0, 4, 1, 4), tablet: rect(4, 0, 4, 4), desktop: rect(4, 0, 4, 4) };
    const widgets = [
      { id: "a", type: "register-table", layout: a },
      { id: "b", type: "register-table", layout: b },
    ];
    for (const name of ["phone", "tablet", "desktop"] as const) {
      const moved = placeInLayout(widgets, name, "a", { ...widgets[1]!.layout[name] }, ONE);
      for (const other of ["phone", "tablet", "desktop"] as const) {
        if (other === name) continue;
        expect(moved.map((widget) => widget.layout[other]), `${name} moved, ${other} kept`).toEqual(widgets.map((widget) => widget.layout[other]));
      }
      expect(moved[0]!.layout[name]).toEqual(b[name]);
      expect(moved[1]!.layout[name].y).toBe(b[name].y + b[name].h);
    }
  });
});
