// D35.2 — the history of the Designer (Scope §5.4, Architektura §7.2, AR17): every change of the design
// is a step, a typed field is one step until it is left, undo and redo bring the whole design back with
// the same widget ids and bindings, and only the last 100 steps are kept; a design saved in another tab
// is told from this tab's own save (D35.3).
import type { LayoutDto, ScreenDto, WidgetDesignDto } from "@openlife/contracts/http/screens";
import { describe, expect, it } from "vitest";
import { canRedo, canUndo, changedElsewhere, designerReducer, HISTORY_LIMIT, isDirty, startState, type DesignerAction, type DesignerState } from "../../../apps/web/src/features/dashboard/lib/designer-state.js";

const r = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const A = "01900000-0000-7000-8000-0000000035a1";
const B = "01900000-0000-7000-8000-0000000035b1";
const layout: LayoutDto = { phone: r(0, 0, 1, 6), tablet: r(0, 0, 4, 6), desktop: r(0, 0, 4, 6) };
const bound: WidgetDesignDto = { id: A, type: "register-table", config: { v: 1, title: "Moje" }, layout, bindings: [{ slot: "registry", ordinal: 0, path: "Field.Register.k", target: { kind: "registry", registryId: "01900000-0000-7000-8000-0000000035f1" } }] };
const screen: ScreenDto = { id: "01900000-0000-7000-8000-0000000035c1", name: "Main", theme: "dark", accent: "blue", createdAt: "2026-11-04T08:00:00.000Z", updatedAt: "2026-11-04T08:00:00.000Z", widgets: [{ ...bound, state: "ok" }] };
const run = (state: DesignerState, ...actions: DesignerAction[]): DesignerState => actions.reduce(designerReducer, state);
const move = (x: number): DesignerAction => ({ kind: "placed", layout: "desktop", id: A, rect: r(x, 0, 4, 6), minimum: { w: 1, h: 1 } });

describe("D35.2 the history of the Designer", () => {
  it("starts with nothing to undo or redo; a change can be undone and redone", () => {
    const start = startState(screen);
    expect([canUndo(start), canRedo(start)]).toEqual([false, false]);
    const moved = run(start, move(2));
    const back = run(moved, { kind: "undo" });
    expect(back.design).toEqual(start.design);
    expect(isDirty(back)).toBe(false);
    expect(canRedo(back)).toBe(true);
    expect(run(back, { kind: "redo" }).design).toEqual(moved.design);
  });

  it("a deletion undone brings back the same widget id, configuration and bindings, even after the save", () => {
    const removed = run(startState(screen), { kind: "select", id: A }, { kind: "remove", id: A });
    const saved = run(removed, { kind: "saved", sent: removed.design, received: removed.design });
    expect(saved.design.widgets).toEqual([]);
    const back = run(saved, { kind: "undo" });
    expect(back.design.widgets).toEqual([bound]);
    expect(isDirty(back)).toBe(true);
  });

  it("the typing of one field is one step until it is left; another field, a selection or an undo starts a new one", () => {
    const type = (title: string, field = `${A}:title`): DesignerAction => ({ kind: "configured", id: A, config: { v: 1, title }, bindings: bound.bindings, field });
    const typed = run(startState(screen), type("M"), type("Mo"), type("Mój"));
    expect(typed.past).toHaveLength(1);
    const settled = run(typed, { kind: "settle" }, type("Mója"));
    expect(settled.past).toHaveLength(2);
    expect(run(settled, type("Mójab", `${A}:pageSize`)).past).toHaveLength(3);
    expect(run(typed, { kind: "undo" }).design.widgets[0]!.config["title"]).toBe("Moje");
  });

  it("a new step after an undo drops what was undone; the selection stays only with its widget", () => {
    const later = run(startState(screen), move(2), move(4), { kind: "undo" }, move(6));
    expect(canRedo(later)).toBe(false);
    expect(later.past.map((design) => design.widgets[0]!.layout.desktop.x)).toEqual([0, 2]);
    const added = run(startState(screen), { kind: "add", widget: { ...bound, id: B } });
    expect(added.selectedId).toBe(B);
    expect(run(added, { kind: "undo" }).selectedId).toBeNull();
  });

  it(`keeps ${HISTORY_LIMIT} steps: the 101st drops the oldest`, () => {
    let state = startState(screen);
    for (let step = 1; step <= HISTORY_LIMIT + 1; step += 1) state = run(state, move(step % 2 === 0 ? 0 : 1 + (step % 7)));
    expect(state.past).toHaveLength(HISTORY_LIMIT);
    for (let step = 0; step < HISTORY_LIMIT; step += 1) state = run(state, { kind: "undo" });
    expect(canUndo(state)).toBe(false);
    // The first step stays done: its design before is the one that was dropped.
    expect(state.design.widgets[0]!.layout.desktop.x).toBe(2);
  });
});

describe("D35.3 a layout saved in another tab", () => {
  it("the server's design is another tab's only when it is neither the one last saved here nor the one held here", () => {
    const start = startState(screen);
    const moved = run(start, move(2));
    expect(changedElsewhere(start.design, moved)).toBe(false);
    expect(changedElsewhere(moved.design, moved)).toBe(false);
    const theirs = { ...start.design, widgets: [{ ...bound, config: { v: 1, title: "Z karty A" } }] };
    expect(changedElsewhere(theirs, moved)).toBe(true);
  });

  it("taking the other tab's design makes it the new start, with no history and nothing to save", () => {
    const theirs = { ...startState(screen).design, widgets: [{ ...bound, config: { v: 1, title: "Z karty A" } }] };
    const taken = run(startState(screen), move(2), { kind: "select", id: A }, { kind: "loaded", design: theirs });
    expect(taken.design).toEqual(theirs);
    expect(isDirty(taken)).toBe(false);
    expect([canUndo(taken), canRedo(taken)]).toEqual([false, false]);
    expect(taken.selectedId).toBe(A);
  });
});

describe("D47.3 the history of an import of a template", () => {
  const imported = { ...startState(screen).design, name: "From a template", widgets: [{ ...bound, id: B }] };

  it("is one step: the design before it comes back by undo, which is saved as the older design, and the import itself is the new start", () => {
    const start = run(startState(screen), move(2));
    const after = run(start, { kind: "imported", design: imported });
    expect(after.design).toEqual(imported);
    expect(isDirty(after)).toBe(false);
    expect(canUndo(after)).toBe(true);
    const back = run(after, { kind: "undo" });
    expect(back.design).toEqual(start.design);
    expect(isDirty(back)).toBe(true);
  });

  it("cannot be redone, since the widgets of the file are gone from the server once the older design is saved", () => {
    const after = run(startState(screen), { kind: "imported", design: imported });
    const back = run(after, { kind: "undo" });
    expect([canRedo(back), back.imported]).toEqual([false, null]);
    // A step after the import is redone as any, and undoing down to the import then undoing it drops what was left to redo.
    const edited = run(after, { kind: "placed", layout: "desktop", id: B, rect: r(2, 0, 4, 6), minimum: { w: 1, h: 1 } });
    const undone = run(edited, { kind: "undo" });
    expect(canRedo(undone)).toBe(true);
    expect(canRedo(run(undone, { kind: "undo" }))).toBe(false);
  });

  it("clears what was undone before it and takes the design of another tab as a new start without the mark", () => {
    const undone = run(startState(screen), move(2), { kind: "undo" });
    expect(canRedo(undone)).toBe(true);
    const after = run(undone, { kind: "imported", design: imported });
    expect([canRedo(after), after.selectedId]).toEqual([false, null]);
    expect(run(after, { kind: "loaded", design: imported }).imported).toBeNull();
  });
});
