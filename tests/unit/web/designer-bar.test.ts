// D34.1 — the rules behind the context bar: Delete takes the widget and its selection, a copy has its
// own size at the first free place of each layout, a chosen registry gives all its columns in its order,
// and the bar checks a field with the very schema the server applies.
import type { RegistryDto } from "@openlife/contracts/http/registries";
import type { LayoutDto, ScreenDto, WidgetDesignDto } from "@openlife/contracts/http/screens";
import { PAGE_SIZE_RANGE, registerTableConfigSchema } from "../../../packages/widgets/dist/views.js";
import { describe, expect, it } from "vitest";
import { designerReducer, startState } from "../../../apps/web/src/features/dashboard/lib/designer-state.js";
import { placeCopy } from "../../../apps/web/src/features/dashboard/lib/layout-edit.js";
import { allColumnsOf } from "../../../apps/web/src/features/dashboard/lib/register-table-bindings.js";

const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const A = "01900000-0000-7000-8000-0000000034aa";
const B = "01900000-0000-7000-8000-0000000034bb";
const layout: LayoutDto = { phone: r(0, 0, 1, 6), tablet: r(0, 0, 4, 6), desktop: r(0, 0, 4, 6) };
const widget = (id: string): WidgetDesignDto => ({ id, type: "register-table", config: { v: 1 }, layout, bindings: [] });
const screen: ScreenDto = { id: "01900000-0000-7000-8000-0000000034cc", name: "Main", theme: "dark", accent: "blue", createdAt: "2026-11-03T10:00:00.000Z", updatedAt: "2026-11-03T10:00:00.000Z", widgets: [{ ...widget(A), state: "draft" }, { ...widget(B), state: "draft" }] };

describe("D34.1 the rules of the context bar", () => {
  it("Delete removes the widget and its selection, and the other widget stays", () => {
    const selected = designerReducer(startState(screen), { kind: "select", id: B });
    const removed = designerReducer(selected, { kind: "remove", id: B });
    expect(removed.design.widgets.map((each) => each.id)).toEqual([A]);
    expect(removed.selectedId).toBeNull();
    expect(designerReducer(removed, { kind: "remove", id: B })).toBe(removed);
  });

  it("a copy keeps its size in each layout at the first free place there", () => {
    expect(placeCopy([{ layout }], layout)).toEqual({ phone: r(0, 6, 1, 6), tablet: r(4, 0, 4, 6), desktop: r(4, 0, 4, 6) });
  });

  it("a chosen registry gives all its columns in the order of the registry, and no system column", () => {
    const column = (id: string, position: number) => ({ id, symbol: `c${position}`, displayName: `C${position}`, type: "text" as const, typeOptions: {}, defaultValue: null, required: false, position });
    const registry = { id: "01900000-0000-7000-8000-0000000034f1", symbol: "x", displayName: "X", schemaRevision: 1, dataRevision: 0, createdAt: "", updatedAt: "", columns: [column("c-1", 0), column("c-2", 1), column("c-3", 2)] } as RegistryDto;
    expect(allColumnsOf(registry)).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("the page size and the title the bar accepts are the ones the server's schema accepts", () => {
    const accepts = (change: Record<string, unknown>) => registerTableConfigSchema.safeParse({ v: 1, ...change }).success;
    expect([0, 1, 10, 100, 101, 2.5].map((pageSize) => accepts({ pageSize }))).toEqual([false, true, true, true, false, false]);
    expect(PAGE_SIZE_RANGE).toEqual({ min: 1, max: 100, default: 10 });
    expect(accepts({ title: "x".repeat(80) })).toBe(true);
    expect(accepts({ title: "x".repeat(81) })).toBe(false);
  });
});
