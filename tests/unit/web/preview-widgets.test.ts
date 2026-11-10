// D39.3 — the widgets of the preview (Scope §5.4): the design being arranged with the states the server
// worked out; a widget it has not seen yet is a draft, which the preview shows with sample data.
import type { DesignSnapshotDto, ScreenDto } from "@openlife/contracts/http/screens";
import { describe, expect, it } from "vitest";
import { previewWidgets } from "../../../apps/web/src/features/dashboard/lib/preview-widgets.js";

const RECT = { x: 0, y: 0, w: 4, h: 4 };
const AT = { phone: RECT, tablet: RECT, desktop: RECT };
const widget = (id: string) => ({ id, type: "register-table", config: { v: 1 }, layout: AT, bindings: [] });

describe("D39.3 the widgets of the preview", () => {
  it("keeps the state the server worked out and makes a widget it has not seen a draft", () => {
    const saved = { id: "s", name: "Pulpit", theme: "dark", accent: "blue", createdAt: "2026-11-10T08:00:00.000Z", updatedAt: "2026-11-10T08:00:00.000Z", widgets: [{ ...widget("a"), state: "needs_rebinding" }, { ...widget("b"), state: "ok" }] } as ScreenDto;
    const design: DesignSnapshotDto = { name: "Pulpit", theme: "dark", accent: "blue", widgets: [widget("b"), widget("a"), widget("new")] };
    expect(previewWidgets(design, saved).map(({ id, state }) => [id, state])).toEqual([["b", "ok"], ["a", "needs_rebinding"], ["new", "draft"]]);
  });

  it("draws the design being arranged, not the saved one: a removed widget is gone and a moved one is where it is now", () => {
    const saved = { id: "s", name: "Pulpit", theme: "dark", accent: "blue", createdAt: "2026-11-10T08:00:00.000Z", updatedAt: "2026-11-10T08:00:00.000Z", widgets: [{ ...widget("a"), state: "ok" }, { ...widget("b"), state: "ok" }] } as ScreenDto;
    const moved = { ...widget("a"), layout: { ...AT, desktop: { ...RECT, x: 6 } } };
    const shown = previewWidgets({ name: "Pulpit", theme: "dark", accent: "blue", widgets: [moved] }, saved);
    expect(shown.map((each) => each.id)).toEqual(["a"]);
    expect(shown[0]!.layout.desktop.x).toBe(6);
  });
});
