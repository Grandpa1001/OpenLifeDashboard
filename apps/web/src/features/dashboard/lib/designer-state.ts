// The state of the Designer (Architektura §7.2, §18.5; D18.2, D35): the design the owner is arranging,
// the design last saved, the widget that is selected and the history of the design for undo and redo.
// "Unsaved" is the difference between the design and the one last saved; the autosave sends it.
import type { DesignSnapshotDto, LayoutName, LayoutRectDto, ScreenDto, WidgetDesignDto } from "@openlife/contracts/http/screens";
import { placeInLayout, type Size } from "./layout-edit.js";

/** The steps kept for undo (Scope §5.4): the oldest goes when the 101st comes. */
export const HISTORY_LIMIT = 100;

export type DesignerState = Readonly<{
  baseline: DesignSnapshotDto;
  design: DesignSnapshotDto;
  selectedId: string | null;
  /** The designs before each step, the newest last, and the ones undone, the newest undone last. */
  past: readonly DesignSnapshotDto[];
  future: readonly DesignSnapshotDto[];
  /** The field being typed into: its changes are one step until it is left (`settle`). */
  typing: string | null;
  /** The design a template made, while nothing has changed since: undoing it cannot be redone, since the file is not kept (D47.3). */
  imported: DesignSnapshotDto | null;
  /** Counts the undos and redos, so fields that keep what is typed take the design that came back. */
  restored: number;
}>;

export type DesignerAction =
  | Readonly<{ kind: "add"; widget: WidgetDesignDto }>
  /** One widget moved or resized in one layout, by the mouse, the touch or the keyboard: the collisions and the minimum of `placeInLayout` apply. */
  | Readonly<{ kind: "placed"; layout: LayoutName; id: string; rect: LayoutRectDto; minimum: Size }>
  /** `field` names a text being typed: its changes are one step until the field is left. */
  | Readonly<{ kind: "configured"; id: string; config: WidgetDesignDto["config"]; bindings: WidgetDesignDto["bindings"]; field?: string }>
  | Readonly<{ kind: "select"; id: string | null }>
  | Readonly<{ kind: "remove"; id: string }>
  | Readonly<{ kind: "saved"; sent: DesignSnapshotDto; received: DesignSnapshotDto }>
  /** The design another tab saved, taken in place of this one (D35.3): it is the new start, with no history behind it. */
  | Readonly<{ kind: "loaded"; design: DesignSnapshotDto }>
  /** A template the server applied: its design is the new start, and the design before it is one step of the history. */
  | Readonly<{ kind: "imported"; design: DesignSnapshotDto }>
  | Readonly<{ kind: "undo" }>
  | Readonly<{ kind: "redo" }>
  /** The field being typed into was left: its next change is a step of its own. */
  | Readonly<{ kind: "settle" }>;

/** What the owner designs, without what the server works out (the state of a widget). */
export function toSnapshot(screen: ScreenDto): DesignSnapshotDto {
  return {
    name: screen.name,
    theme: screen.theme,
    accent: screen.accent,
    widgets: screen.widgets.map(({ id, type, config, layout, bindings }) => ({ id, type, config, layout, bindings })),
  };
}

export const startState = (screen: ScreenDto): DesignerState => {
  const snapshot = toSnapshot(screen);
  return { baseline: snapshot, design: snapshot, selectedId: null, past: [], future: [], typing: null, imported: null, restored: 0 };
};

/** JSON with the keys in order, so two designs with the same content are the same text whatever built them. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

export const isDirty = (state: DesignerState): boolean => canonicalJson(state.design) !== canonicalJson(state.baseline);

/**
 * A change of the design as a step of the history: the design before it is kept (at most
 * `HISTORY_LIMIT`), what was undone is dropped. The changes of one field being typed into are one
 * step: only the first of them keeps the design before.
 */
function step(state: DesignerState, design: DesignSnapshotDto, extra: Partial<Pick<DesignerState, "selectedId">> = {}, field: string | null = null): DesignerState {
  const continues = field !== null && state.typing === field;
  const past = continues ? state.past : [...state.past, state.design].slice(-HISTORY_LIMIT);
  return { ...state, ...extra, design, past, future: continues ? state.future : [], typing: field };
}

/** The selection after an undo or a redo: kept when its widget is still there. */
const selectionIn = (design: DesignSnapshotDto, selectedId: string | null): string | null => (selectedId !== null && design.widgets.some((widget) => widget.id === selectedId) ? selectedId : null);

export const canUndo = (state: DesignerState): boolean => state.past.length > 0;
export const canRedo = (state: DesignerState): boolean => state.future.length > 0;

export function designerReducer(state: DesignerState, action: DesignerAction): DesignerState {
  switch (action.kind) {
    case "add":
      return step(state, { ...state.design, widgets: [...state.design.widgets, action.widget] }, { selectedId: action.widget.id });
    case "placed": {
      const widgets = placeInLayout(state.design.widgets, action.layout, action.id, action.rect, action.minimum);
      return widgets === state.design.widgets ? state : step(state, { ...state.design, widgets: [...widgets] });
    }
    case "configured":
      return step(
        state,
        { ...state.design, widgets: state.design.widgets.map((widget) => (widget.id === action.id ? { ...widget, config: action.config, bindings: action.bindings } : widget)) },
        {},
        action.field ?? null,
      );
    case "remove": {
      // Removed without a question; the bar "Undo" and the history bring it back.
      const widgets = state.design.widgets.filter((widget) => widget.id !== action.id);
      return widgets.length === state.design.widgets.length ? state : step(state, { ...state.design, widgets }, { selectedId: state.selectedId === action.id ? null : state.selectedId });
    }
    case "imported":
      return { ...state, baseline: action.design, design: action.design, past: [...state.past, state.design].slice(-HISTORY_LIMIT), future: [], typing: null, imported: action.design, selectedId: null, restored: state.restored + 1 };
    case "loaded":
      return { ...state, baseline: action.design, design: action.design, past: [], future: [], typing: null, imported: null, selectedId: selectionIn(action.design, state.selectedId), restored: state.restored + 1 };
    case "undo": {
      const previous = state.past.at(-1);
      if (previous === undefined) return state;
      // The design of an import is not kept to redo: its widgets are gone from the server once the older design is saved.
      const undoingImport = state.imported !== null && canonicalJson(state.design) === canonicalJson(state.imported);
      return { ...state, design: previous, past: state.past.slice(0, -1), future: undoingImport ? [] : [...state.future, state.design], imported: undoingImport ? null : state.imported, selectedId: selectionIn(previous, state.selectedId), typing: null, restored: state.restored + 1 };
    }
    case "redo": {
      const next = state.future.at(-1);
      if (next === undefined) return state;
      return { ...state, design: next, past: [...state.past, state.design].slice(-HISTORY_LIMIT), future: state.future.slice(0, -1), selectedId: selectionIn(next, state.selectedId), typing: null, restored: state.restored + 1 };
    }
    case "settle":
      return state.typing === null ? state : { ...state, typing: null };
    case "select":
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id, typing: null };
    case "saved": {
      // Edits made while the save was in flight stay; only when there were none does the design take the server's wording (a trimmed name, the defaults of a configuration).
      const untouched = canonicalJson(state.design) === canonicalJson(action.sent);
      return { ...state, baseline: action.received, design: untouched ? action.received : state.design };
    }
  }
}

/** A new widget of a type: its configuration at the version of this build, unbound, and a place in each layout. */
export function newWidget(id: string, type: string, configVersion: number, layout: WidgetDesignDto["layout"]): WidgetDesignDto {
  return { id, type, config: { v: configVersion }, layout, bindings: [] };
}

/**
 * Whether the screen on the server is another tab's work (D35.3): a design that is neither the one
 * this tab last saved nor the one it holds now. A save of this tab whose answer was lost is its own,
 * not a change from elsewhere.
 */
export function changedElsewhere(server: DesignSnapshotDto, state: DesignerState): boolean {
  const there = canonicalJson(server);
  return there !== canonicalJson(state.baseline) && there !== canonicalJson(state.design);
}
