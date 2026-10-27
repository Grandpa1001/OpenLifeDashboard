// The design of a screen as the rules see it (Architektura §4.2, §5.3–5.6, §18.3, §18.5): a snapshot
// the Designer sends whole, and what the rules make of it. These types are the module's own; the
// transport schemas in contracts describe the same shapes, and a test keeps the two together.

/** What a binding points at, by permanent identifier (Architektura §5.6). */
export type FieldRef =
  | Readonly<{ kind: "registry"; registryId: string }>
  | Readonly<{ kind: "column"; registryId: string; columnId: string }>
  | Readonly<{ kind: "systemColumn"; registryId: string; symbol: "created_at" | "updated_at" | "id" }>
  | Readonly<{ kind: "config"; entryId: string }>
  | Readonly<{ kind: "system"; symbol: "dzis" | "wczoraj" | "teraz" | "strefa" | "jezyk" | "wersja" }>;

export type SlotBinding = Readonly<{
  slot: string;
  ordinal: number;
  /** The readable name, `Field.Register.<registry>.<column>`; the target is the identity and the path must agree with it. */
  path: string;
  target: FieldRef;
}>;

export type LayoutRect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type Layout = Readonly<{ phone: LayoutRect; tablet: LayoutRect; desktop: LayoutRect }>;
export const LAYOUT_NAMES = ["phone", "tablet", "desktop"] as const;
export type LayoutName = (typeof LAYOUT_NAMES)[number];

export type WidgetState = "draft" | "ok" | "needs_rebinding" | "needs_refresh";

export type WidgetInput = Readonly<{ id: string; type: string; config: Readonly<Record<string, unknown>>; layout: Layout; bindings: readonly SlotBinding[] }>;
export type DesignInput = Readonly<{ name: string; theme: string; accent: string; widgets: readonly WidgetInput[] }>;

/** A widget after the rules: the configuration in its current version (or as it came, when it needs a refresh) and the state worked out. */
export type CheckedWidget = Readonly<{ id: string; type: string; config: Readonly<Record<string, unknown>>; layout: Layout; bindings: readonly SlotBinding[]; state: WidgetState }>;
export type CheckedDesign = Readonly<{ name: string; theme: string; accent: string; widgets: readonly CheckedWidget[] }>;

/** The numbers the rules hold a design to; the caller gives them (they are the limits of the contract). */
export type DesignPolicy = Readonly<{
  maxWidgets: number;
  maxBindingsPerWidget: number;
  /** Bytes of the JSON of the configuration, and of the bindings, of one widget. */
  maxWidgetJsonBytes: number;
  nameMaxChars: number;
  themes: readonly string[];
  accents: readonly string[];
  gridColumns: Readonly<Record<LayoutName, number>>;
}>;

export type DesignIssueCode =
  | "NAME_INVALID"
  | "THEME_UNKNOWN"
  | "ACCENT_UNKNOWN"
  | "LIMIT_WIDGETS"
  | "WIDGET_ID_INVALID"
  | "WIDGET_ID_DUPLICATE"
  | "WIDGET_ID_TAKEN"
  | "WIDGET_TYPE_UNKNOWN"
  | "CONFIG_INVALID"
  | "CONFIG_TOO_LARGE"
  | "LIMIT_BINDINGS"
  | "BINDINGS_TOO_LARGE"
  | "SLOT_UNKNOWN"
  | "SLOT_TOO_MANY"
  | "TARGET_KIND_NOT_ACCEPTED"
  | "ORDINAL_DUPLICATE"
  | "ORDINAL_GAP"
  | "TARGET_UNKNOWN"
  | "TARGET_UNSUPPORTED"
  | "PATH_MISMATCH"
  | "REGISTRY_MISMATCH"
  | "LAYOUT_OUT_OF_GRID"
  | "LAYOUT_TOO_SMALL";

/** Where and why a design is refused: the path of the field in the snapshot and a stable code, never a value. */
export type DesignIssue = Readonly<{ path: string; code: DesignIssueCode }>;
export type DesignResult = Readonly<{ ok: true; value: CheckedDesign }> | Readonly<{ ok: false; issues: readonly DesignIssue[] }>;
