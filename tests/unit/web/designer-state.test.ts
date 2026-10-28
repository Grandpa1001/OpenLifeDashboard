// D18.2 — the state of the Designer and the bindings of the register table: what is unsaved, how a
// change of one layout is kept, and the bindings a choice of registry and columns stands for.
import type { RegistryDto } from "@openlife/contracts/http/registries";
import type { DesignSnapshotDto, LayoutDto, ScreenDto, WidgetDesignDto } from "@openlife/contracts/http/screens";
import { describe, expect, it } from "vitest";
import { canonicalJson, designerReducer, isDirty, newWidget, startState, toSnapshot } from "../../../apps/web/src/features/dashboard/lib/designer-state.js";
import { bindingsOf, choiceOf, pickableColumns } from "../../../apps/web/src/features/dashboard/lib/register-table-bindings.js";

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const layout: LayoutDto = { phone: rect(0, 0, 1, 4), tablet: rect(0, 0, 4, 4), desktop: rect(0, 0, 6, 4) };
const A = "01900000-0000-7000-8000-00000000000a";
const B = "01900000-0000-7000-8000-00000000000b";

const widgetOf = (id: string): WidgetDesignDto => ({ id, type: "register-table", config: { v: 1 }, layout, bindings: [] });
const screen: ScreenDto = {
  id: "01900000-0000-7000-8000-0000000000aa",
  name: "Main",
  theme: "dark",
  accent: "blue",
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
  widgets: [{ ...widgetOf(A), state: "draft" }],
};

const registry: RegistryDto = {
  id: "01900000-0000-7000-8000-0000000000f1",
  symbol: "F01",
  displayName: "Expenses",
  schemaRevision: 1,
  dataRevision: 0,
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
  columns: [
    { id: "01900000-0000-7000-8000-0000000000c1", symbol: "amount", displayName: "Amount", type: "money", typeOptions: {}, defaultValue: null, required: true, position: 0 },
    { id: "01900000-0000-7000-8000-0000000000c2", symbol: "note", displayName: "Note", type: "text", typeOptions: {}, defaultValue: null, required: false, position: 1 },
  ],
};

describe("D18.2 the state of the Designer", () => {
  it("starts clean from the screen as the server holds it, without the state the server works out", () => {
    const state = startState(screen);
    expect(isDirty(state)).toBe(false);
    expect(state.design.widgets[0]).not.toHaveProperty("state");
    expect(toSnapshot(screen).widgets[0]).toEqual(widgetOf(A));
  });

  it("adding a widget selects it and makes the design unsaved", () => {
    const next = designerReducer(startState(screen), { kind: "add", widget: newWidget(B, "register-table", 1, layout) });
    expect(next.selectedId).toBe(B);
    expect(next.design.widgets.map((widget) => widget.id)).toEqual([A, B]);
    expect(isDirty(next)).toBe(true);
  });

  it("an arrangement of one layout changes that layout only, and moving back is clean again", () => {
    const start = startState(screen);
    const moved = designerReducer(start, { kind: "arranged", layout: "desktop", items: [{ i: A, x: 6, y: 2, w: 6, h: 4 }] });
    expect(moved.design.widgets[0]?.layout.desktop).toEqual(rect(6, 2, 6, 4));
    expect(moved.design.widgets[0]?.layout.phone).toEqual(layout.phone);
    expect(moved.design.widgets[0]?.layout.tablet).toEqual(layout.tablet);
    expect(isDirty(moved)).toBe(true);
    const back = designerReducer(moved, { kind: "arranged", layout: "desktop", items: [{ i: A, x: 0, y: 0, w: 6, h: 4 }] });
    expect(isDirty(back)).toBe(false);
  });

  it("a report of the grid that changes nothing is the very same state", () => {
    const start = startState(screen);
    expect(designerReducer(start, { kind: "arranged", layout: "tablet", items: [{ i: A, x: 0, y: 0, w: 4, h: 4 }] })).toBe(start);
  });

  it("configuring a widget replaces its configuration and bindings", () => {
    const bindings = bindingsOf(registry, [registry.columns[0]?.id ?? ""], null);
    const next = designerReducer(startState(screen), { kind: "configured", id: A, config: { v: 1, sortDirection: "asc" }, bindings });
    expect(next.design.widgets[0]?.bindings).toEqual(bindings);
    expect(next.design.widgets[0]?.config).toEqual({ v: 1, sortDirection: "asc" });
    expect(isDirty(next)).toBe(true);
  });

  it("a save takes the server's wording when nothing changed meanwhile, and keeps newer edits when something did", () => {
    const start = startState(screen);
    const edited = designerReducer(start, { kind: "add", widget: newWidget(B, "register-table", 1, layout) });
    const sent: DesignSnapshotDto = edited.design;
    const received: DesignSnapshotDto = { ...sent, name: "Main" };
    const clean = designerReducer(edited, { kind: "saved", sent, received });
    expect(isDirty(clean)).toBe(false);

    const later = designerReducer(edited, { kind: "arranged", layout: "phone", items: [{ i: B, x: 0, y: 9, w: 1, h: 4 }] });
    const kept = designerReducer(later, { kind: "saved", sent, received });
    expect(kept.baseline).toBe(received);
    expect(kept.design).toBe(later.design);
    expect(isDirty(kept)).toBe(true);
  });

  it("two designs with the same content are the same whatever order their keys came in", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });
});

describe("D18.2 the bindings of the register table", () => {
  const [amount, note] = registry.columns;

  it("write the registry, the columns in the order of the registry and the sort column, each with the path the server checks", () => {
    const bindings = bindingsOf(registry, [note?.id ?? "", amount?.id ?? "", "created_at"], note?.id ?? null);
    expect(bindings).toEqual([
      { slot: "registry", ordinal: 0, path: "Field.Register.F01", target: { kind: "registry", registryId: registry.id } },
      { slot: "columns", ordinal: 0, path: "Field.Register.F01.amount", target: { kind: "column", registryId: registry.id, columnId: amount?.id } },
      { slot: "columns", ordinal: 1, path: "Field.Register.F01.note", target: { kind: "column", registryId: registry.id, columnId: note?.id } },
      { slot: "columns", ordinal: 2, path: "Field.Register.F01.created_at", target: { kind: "systemColumn", registryId: registry.id, symbol: "created_at" } },
      { slot: "sortColumn", ordinal: 0, path: "Field.Register.F01.note", target: { kind: "column", registryId: registry.id, columnId: note?.id } },
    ]);
  });

  it("without a registry there is nothing bound, and a column the registry does not have is left out", () => {
    expect(bindingsOf(null, ["x"], "x")).toEqual([]);
    expect(bindingsOf(registry, ["01900000-0000-7000-8000-0000000000ff"], "01900000-0000-7000-8000-0000000000fe")).toHaveLength(1);
  });

  it("are read back as the same choice", () => {
    const keys = [amount?.id ?? "", "updated_at"];
    expect(choiceOf(bindingsOf(registry, keys, "created_at"))).toEqual({ registryId: registry.id, columnKeys: keys, sortKey: "created_at" });
    expect(choiceOf([])).toEqual({ registryId: null, columnKeys: [], sortKey: null });
  });

  it("offer the columns of the registry and the system columns, whose keys cannot be taken for an identifier", () => {
    const offer = pickableColumns(registry);
    expect(offer.map((pick) => pick.key)).toEqual([amount?.id, note?.id, "created_at", "updated_at"]);
    expect(offer.filter((pick) => pick.system !== null).map((pick) => pick.label)).toEqual([null, null]);
  });
});
