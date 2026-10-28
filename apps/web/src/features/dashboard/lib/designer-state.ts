// The state of the Designer (Architektura §7.2, §18.5; D18.2): the design the owner is arranging, the
// design last saved, and the widget that is selected. The owner saves explicitly in this step, so
// "unsaved" is the difference between the two designs.
import type { DesignSnapshotDto, LayoutName, ScreenDto, WidgetDesignDto } from "@openlife/contracts/http/screens";
import { applyGridItems } from "./layout-edit.js";

export type DesignerState = Readonly<{ baseline: DesignSnapshotDto; design: DesignSnapshotDto; selectedId: string | null }>;

export type DesignerAction =
  | Readonly<{ kind: "add"; widget: WidgetDesignDto }>
  | Readonly<{ kind: "arranged"; layout: LayoutName; items: readonly Readonly<{ i: string; x: number; y: number; w: number; h: number }>[] }>
  | Readonly<{ kind: "configured"; id: string; config: WidgetDesignDto["config"]; bindings: WidgetDesignDto["bindings"] }>
  | Readonly<{ kind: "select"; id: string | null }>
  | Readonly<{ kind: "saved"; sent: DesignSnapshotDto; received: DesignSnapshotDto }>;

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
  return { baseline: snapshot, design: snapshot, selectedId: null };
};

/** JSON with the keys in order, so two designs with the same content are the same text whatever built them. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

export const isDirty = (state: DesignerState): boolean => canonicalJson(state.design) !== canonicalJson(state.baseline);

export function designerReducer(state: DesignerState, action: DesignerAction): DesignerState {
  switch (action.kind) {
    case "add":
      return { ...state, design: { ...state.design, widgets: [...state.design.widgets, action.widget] }, selectedId: action.widget.id };
    case "arranged": {
      const widgets = applyGridItems(state.design.widgets, action.layout, action.items);
      return widgets === state.design.widgets ? state : { ...state, design: { ...state.design, widgets: [...widgets] } };
    }
    case "configured":
      return {
        ...state,
        design: { ...state.design, widgets: state.design.widgets.map((widget) => (widget.id === action.id ? { ...widget, config: action.config, bindings: action.bindings } : widget)) },
      };
    case "select":
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
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
