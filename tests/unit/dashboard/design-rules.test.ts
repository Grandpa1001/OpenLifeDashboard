// D17.2 — the rules of the design of a screen (Architektura §5.5, §5.6, §18.3, §18.5): the screen of
// F01 is accepted with its states worked out, a binding that is broken since is a state and not a
// refusal, and what cannot be trusted (a foreign target, a path that disagrees with the identity, two
// registries in one widget, a layout off the grid, a taken widget id) is refused with the path of the
// field and a stable code. The catalog of widgets is the real one of the build.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWidgetCatalog } from "../../../apps/server/dist/adapters/widget-catalog.js";
import { DESIGN_LIMITS, GRID_COLUMNS, SCREEN_ACCENTS, SCREEN_THEMES, designSnapshotSchema } from "../../../packages/contracts/dist/http/screens.js";
import {
  stateOfStoredWidget,
  validateDesign,
  type CatalogRegistry,
  type DashboardCatalogReader,
  type DesignContext,
  type DesignInput,
  type DesignIssue,
  type DesignPolicy,
  type SlotBinding,
  type WidgetInput,
} from "../../../packages/core/dist/modules/dashboard/public.js";

const root = path.resolve(import.meta.dirname, "../../..");
type FixtureColumn = { id: string; symbol: string };
const fixture = JSON.parse(readFileSync(path.join(root, "tests/fixtures/books/books-v1.export.json"), "utf8")) as {
  registries: Array<{ id: string; symbol: string; columns: FixtureColumn[] }>;
  screens: Array<{ id: string; name: string; theme: string; accent: string; widgets: WidgetInput[] }>;
};
const BOOKS = fixture.registries[0]!;
const F01_TABLE = fixture.screens[0]!.widgets[0]!;
const OWNER = "owner-1";
const SCREEN = "019a0000-0000-7000-8000-000000000190";
const OTHER_SCREEN = "019a0000-0000-7000-8000-0000000001ff";

const WAGA: CatalogRegistry = {
  id: "019a0000-0000-7000-8000-000000000500",
  symbol: "waga",
  deleted: false,
  columns: [{ id: "019a0000-0000-7000-8000-000000000501", symbol: "kg", deleted: false }],
};
const booksRegistry = (patch: Partial<CatalogRegistry> = {}): CatalogRegistry => ({ id: BOOKS.id, symbol: BOOKS.symbol, deleted: false, columns: BOOKS.columns.map((column) => ({ id: column.id, symbol: column.symbol, deleted: false })), ...patch });

const policy: DesignPolicy = {
  maxWidgets: DESIGN_LIMITS.widgetsPerScreen,
  maxBindingsPerWidget: DESIGN_LIMITS.bindingsPerWidget,
  maxWidgetJsonBytes: DESIGN_LIMITS.widgetJsonBytes,
  nameMaxChars: DESIGN_LIMITS.nameMaxChars,
  themes: SCREEN_THEMES,
  accents: SCREEN_ACCENTS,
  gridColumns: GRID_COLUMNS,
};

/** A context over a catalog the test controls; `lookups` counts the questions put to the registries. */
function contextOf(registries: readonly CatalogRegistry[] = [booksRegistry(), WAGA], widgetScreens: Record<string, string> = {}, overridePolicy: Partial<DesignPolicy> = {}) {
  const lookups: string[] = [];
  const catalog: DashboardCatalogReader = {
    registry: (owner, id) => {
      lookups.push(id);
      return owner === OWNER ? (registries.find((registry) => registry.id === id) ?? null) : null;
    },
    screenOfWidget: (id) => widgetScreens[id] ?? null,
  };
  const context: DesignContext = { ownerId: OWNER, screenId: SCREEN, policy: { ...policy, ...overridePolicy }, widgets: createWidgetCatalog(), catalog };
  return { context, lookups };
}

const clone = <T>(value: T): T => structuredClone(value);
const design = (...widgets: WidgetInput[]): DesignInput => ({ name: "Ekran", theme: "dark", accent: "blue", widgets });
const table = (patch: Partial<WidgetInput> = {}): WidgetInput => ({ ...clone(F01_TABLE), ...patch });
const withBindings = (bindings: SlotBinding[]): WidgetInput => table({ bindings });
const bindingsOf = (): SlotBinding[] => [...clone(F01_TABLE.bindings)];
const column = (symbol: string): string => BOOKS.columns.find((candidate) => candidate.symbol === symbol)!.id;
const registryBinding = (): SlotBinding => ({ slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: BOOKS.id } });
const columnBinding = (symbol: string, ordinal: number): SlotBinding => ({ slot: "columns", ordinal, path: `Field.Register.ksiazki.${symbol}`, target: { kind: "column", registryId: BOOKS.id, columnId: column(symbol) } });

const refusal = (input: DesignInput, context: DesignContext = contextOf().context): readonly DesignIssue[] => {
  const result = validateDesign(input, context);
  if (result.ok) throw new Error("the design was accepted");
  return result.issues;
};
const stateOf = (widget: WidgetInput, context: DesignContext = contextOf().context) => {
  const result = validateDesign(design(widget), context);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.issues)}`);
  return result.value.widgets[0]!.state;
};

describe("D17.2-AC1 the screen of F01 and the states of its widgets", () => {
  it("the register table of F01 is accepted: ok, the configuration with its defaults, everything else as it was", () => {
    const result = validateDesign(design(table()), contextOf().context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [widget] = result.value.widgets;
    expect(widget).toMatchObject({ id: F01_TABLE.id, type: "register-table", state: "ok", config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true }, layout: F01_TABLE.layout });
    expect(widget!.bindings).toEqual(F01_TABLE.bindings);
    expect(result.value).toMatchObject({ name: "Ekran", theme: "dark", accent: "blue" });
  });

  it("what the transport schema accepts is what the rules take: the screen of F01 goes through both (the clocks wait for D36)", () => {
    const snapshot = designSnapshotSchema.parse({ name: "Test MVP", theme: "dark", accent: "blue", widgets: [F01_TABLE] });
    expect(validateDesign(snapshot as unknown as DesignInput, contextOf().context).ok).toBe(true);
    const withClock = designSnapshotSchema.parse({ name: "Test MVP", theme: "dark", accent: "blue", widgets: fixture.screens[0]!.widgets });
    expect(refusal(withClock as unknown as DesignInput)).toEqual([
      { path: "widgets.1.type", code: "WIDGET_TYPE_UNKNOWN" },
      { path: "widgets.2.type", code: "WIDGET_TYPE_UNKNOWN" },
    ]);
  });

  it("a widget with no bindings, or without its columns, is a draft; without a sort column it is still ok", () => {
    expect(stateOf(withBindings([]))).toBe("draft");
    expect(stateOf(withBindings([registryBinding()]))).toBe("draft");
    expect(stateOf(withBindings([columnBinding("tytul", 0)]))).toBe("draft");
    expect(stateOf(withBindings([registryBinding(), columnBinding("tytul", 0), columnBinding("autor", 1)]))).toBe("ok");
  });

  it("the minimal binding of the plan, two columns and the sort by creation, is ok", () => {
    const minimal = bindingsOf().filter((binding) => binding.path !== "Field.Register.ksiazki.status");
    expect(minimal.map((binding) => binding.path)).toEqual(["Field.Register.ksiazki", "Field.Register.ksiazki.tytul", "Field.Register.ksiazki.autor", "Field.Register.ksiazki.created_at"]);
    expect(stateOf(withBindings(minimal))).toBe("ok");
  });

  it("a column or a registry deleted since is not a refusal: the screen is accepted and the widget is needs_rebinding", () => {
    const deletedColumn = booksRegistry({ columns: BOOKS.columns.map((each) => ({ id: each.id, symbol: each.symbol, deleted: each.symbol === "autor" })) });
    expect(stateOf(table(), contextOf([deletedColumn]).context)).toBe("needs_rebinding");
    expect(stateOf(table(), contextOf([booksRegistry({ deleted: true })]).context)).toBe("needs_rebinding");
    // The rest of the screen is saved as it is: a good widget beside a broken one stays ok.
    const result = validateDesign(design(table(), { ...table(), id: "019a0000-0000-7000-8000-0000000001a1", bindings: [registryBinding(), columnBinding("tytul", 0)] }), contextOf([deletedColumn]).context);
    expect(result.ok && result.value.widgets.map((widget) => widget.state)).toEqual(["needs_rebinding", "ok"]);
  });

  it("a configuration of a version this build does not write is needs_refresh, kept as it came, and it wins over a broken binding", () => {
    const old = table({ config: { v: 2, title: "from the future", unknown: [1, 2] } });
    const result = validateDesign(design(old), contextOf().context);
    expect(result.ok && result.value.widgets[0]).toMatchObject({ state: "needs_refresh", config: { v: 2, title: "from the future", unknown: [1, 2] } });
    expect(stateOf(old, contextOf([booksRegistry({ deleted: true })]).context)).toBe("needs_refresh");
  });

  it("the state of a stored widget is worked out again from the catalog as it is now", () => {
    const { context } = contextOf();
    expect(stateOfStoredWidget(table(), context)).toBe("ok");
    expect(stateOfStoredWidget(withBindings([]), context)).toBe("draft");
    expect(stateOfStoredWidget(table(), contextOf([booksRegistry({ deleted: true })]).context)).toBe("needs_rebinding");
    const deleted = booksRegistry({ columns: BOOKS.columns.map((each) => ({ id: each.id, symbol: each.symbol, deleted: each.symbol === "tytul" })) });
    expect(stateOfStoredWidget(table(), contextOf([deleted]).context)).toBe("needs_rebinding");
    // What a save would refuse is for the owner to confirm again, never a silent read of the data.
    expect(stateOfStoredWidget({ ...table(), type: "clock" }, context)).toBe("needs_refresh");
    expect(stateOfStoredWidget(withBindings([columnBinding("tytul", 0), columnBinding("autor", 2)]), context)).toBe("needs_refresh");
    expect(stateOfStoredWidget(table({ config: { v: 1, pageSize: 0 } }), context)).toBe("needs_refresh");
    expect(stateOfStoredWidget(table(), contextOf([]).context)).toBe("needs_refresh");
  });

  it("the name is trimmed in the result, and the input is not changed", () => {
    const input = design(table());
    const frozen = JSON.stringify(input);
    const result = validateDesign({ ...input, name: "  Mój ekran  " }, contextOf().context);
    expect(result.ok && result.value.name).toBe("Mój ekran");
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("each registry is looked up once however many bindings point at it", () => {
    const { context, lookups } = contextOf();
    validateDesign(design(table(), { ...table(), id: "019a0000-0000-7000-8000-0000000001a2" }), context);
    expect(lookups).toEqual([BOOKS.id]);
  });
});

describe("D17.2-AC2 what is refused, with the path and the code", () => {
  const only = (widget: WidgetInput, context?: DesignContext) => refusal(design(widget), context);

  it("a column of another registry: unknown to the registry the target names, and a second registry in one widget", () => {
    const foreignColumn: SlotBinding = { slot: "columns", ordinal: 1, path: "Field.Register.ksiazki.kg", target: { kind: "column", registryId: BOOKS.id, columnId: WAGA.columns[0]!.id } };
    expect(only(withBindings([registryBinding(), columnBinding("tytul", 0), foreignColumn]))).toEqual([{ path: "widgets.0.bindings.2.target", code: "TARGET_UNKNOWN" }]);
    const ownColumnOfWaga: SlotBinding = { slot: "columns", ordinal: 1, path: "Field.Register.waga.kg", target: { kind: "column", registryId: WAGA.id, columnId: WAGA.columns[0]!.id } };
    expect(only(withBindings([registryBinding(), columnBinding("tytul", 0), ownColumnOfWaga]))).toEqual([{ path: "widgets.0.bindings", code: "REGISTRY_MISMATCH" }]);
    const sortOfWaga: SlotBinding = { slot: "sortColumn", ordinal: 0, path: "Field.Register.waga.created_at", target: { kind: "systemColumn", registryId: WAGA.id, symbol: "created_at" } };
    expect(only(withBindings([registryBinding(), columnBinding("tytul", 0), sortOfWaga]))).toEqual([{ path: "widgets.0.bindings", code: "REGISTRY_MISMATCH" }]);
  });

  it("a target the owner does not have: a registry of someone else, one that never existed, a column that is not in its registry", () => {
    const foreign: SlotBinding = { ...registryBinding(), target: { kind: "registry", registryId: "019a0000-0000-7000-8000-0000000009ff" } };
    expect(only(withBindings([foreign, columnBinding("tytul", 0)]))).toContainEqual({ path: "widgets.0.bindings.0.target", code: "TARGET_UNKNOWN" });
    const ofSomeoneElse = contextOf([booksRegistry()]).context;
    expect(only(table(), { ...ofSomeoneElse, ownerId: "owner-2" }).every((issue) => issue.code === "TARGET_UNKNOWN")).toBe(true);
    const nowhere: SlotBinding = { slot: "columns", ordinal: 1, path: "Field.Register.ksiazki.ghost", target: { kind: "column", registryId: BOOKS.id, columnId: "019a0000-0000-7000-8000-0000000009fe" } };
    expect(only(withBindings([registryBinding(), columnBinding("tytul", 0), nowhere]))).toEqual([{ path: "widgets.0.bindings.2.target", code: "TARGET_UNKNOWN" }]);
  });

  it("the path must agree with the identity: another symbol, another column's name, another case, a path of another kind", () => {
    const swapped: SlotBinding = { ...columnBinding("tytul", 1), path: "Field.Register.ksiazki.autor" };
    expect(only(withBindings([registryBinding(), columnBinding("autor", 0), swapped]))).toEqual([{ path: "widgets.0.bindings.2.path", code: "PATH_MISMATCH" }]);
    for (const path of ["Field.Register.inne.tytul", "field.register.ksiazki.tytul", "Field.Register.ksiazki.TYTUL", "Field.Register.ksiazki.tytul ", "Field.System.dzis", "", "../tytul"]) {
      const issues = only(withBindings([registryBinding(), { ...columnBinding("tytul", 0), path }]));
      expect(issues, JSON.stringify(path)).toEqual([{ path: "widgets.0.bindings.1.path", code: "PATH_MISMATCH" }]);
    }
    expect(only(withBindings([{ ...registryBinding(), path: "Field.Register.waga" }, columnBinding("tytul", 0)]))).toEqual([{ path: "widgets.0.bindings.0.path", code: "PATH_MISMATCH" }]);
  });

  it("a slot that does not exist, a second binding in a slot of one, a kind the slot does not take, a repeated or skipped ordinal", () => {
    const dup = (binding: SlotBinding): SlotBinding[] => [registryBinding(), columnBinding("tytul", 0), binding];
    expect(only(withBindings(dup({ ...columnBinding("autor", 0), slot: "rows" })))).toContainEqual({ path: "widgets.0.bindings", code: "SLOT_UNKNOWN" });
    expect(only(withBindings(dup({ ...registryBinding(), ordinal: 1 })))).toContainEqual({ path: "widgets.0.bindings", code: "SLOT_TOO_MANY" });
    expect(only(withBindings(dup(columnBinding("autor", 0))))).toContainEqual({ path: "widgets.0.bindings", code: "ORDINAL_DUPLICATE" });
    expect(only(withBindings(dup(columnBinding("autor", 2))))).toContainEqual({ path: "widgets.0.bindings", code: "ORDINAL_GAP" });
    expect(only(withBindings(dup({ ...registryBinding(), slot: "columns", ordinal: 1 })))).toContainEqual({ path: "widgets.0.bindings", code: "TARGET_KIND_NOT_ACCEPTED" });
    const configTarget: SlotBinding = { slot: "columns", ordinal: 1, path: "Field.Config.imie", target: { kind: "config", entryId: "019a0000-0000-7000-8000-0000000009fd" } };
    expect(only(withBindings(dup(configTarget)))).toEqual(expect.arrayContaining([{ path: "widgets.0.bindings", code: "TARGET_KIND_NOT_ACCEPTED" }, { path: "widgets.0.bindings.2.target", code: "TARGET_UNSUPPORTED" }]));
  });

  it("a type this build lacks, a configuration that is wrong, and the sizes of the configuration and the bindings", () => {
    expect(only({ ...table(), type: "clock" })).toEqual([{ path: "widgets.0.type", code: "WIDGET_TYPE_UNKNOWN" }]);
    for (const type of ["", "__proto__", "REGISTER-TABLE", "register-table "]) expect(only({ ...table(), type }), JSON.stringify(type)).toEqual([{ path: "widgets.0.type", code: "WIDGET_TYPE_UNKNOWN" }]);
    for (const config of [{ v: 1, pageSize: 0 }, { v: 1, pageSize: 101 }, { v: 1, sortDirection: "up" }, { v: 1, columns: ["tytul"] }, { v: 1, allowAdd: "yes" }]) {
      expect(only(table({ config })), JSON.stringify(config)).toEqual([{ path: "widgets.0.config", code: "CONFIG_INVALID" }]);
    }
    const small = contextOf(undefined, {}, { maxWidgetJsonBytes: 100 }).context;
    expect(only(table({ config: { v: 1, title: "x".repeat(200) } }), small)).toContainEqual({ path: "widgets.0.config", code: "CONFIG_TOO_LARGE" });
    expect(only(table(), small)).toContainEqual({ path: "widgets.0.bindings", code: "BINDINGS_TOO_LARGE" });
    const tight = contextOf(undefined, {}, { maxBindingsPerWidget: 3 }).context;
    expect(only(table(), tight)).toContainEqual({ path: "widgets.0.bindings", code: "LIMIT_BINDINGS" });
  });

  it("a layout off the grid, or smaller than the type allows, in each of the three breakpoints", () => {
    const layout = (patch: Partial<Record<"phone" | "tablet" | "desktop", Partial<WidgetInput["layout"]["phone"]>>>) => ({ ...clone(F01_TABLE.layout), ...Object.fromEntries(Object.entries(patch).map(([name, rect]) => [name, { ...F01_TABLE.layout[name as "phone"], ...rect }])) }) as WidgetInput["layout"];
    expect(only(table({ layout: layout({ desktop: { x: 8, w: 8 } }) }))).toEqual([{ path: "widgets.0.layout.desktop", code: "LAYOUT_OUT_OF_GRID" }]);
    expect(only(table({ layout: layout({ tablet: { x: 1, w: 8 } }) }))).toEqual([{ path: "widgets.0.layout.tablet", code: "LAYOUT_OUT_OF_GRID" }]);
    expect(only(table({ layout: layout({ phone: { w: 2 } }) }))).toEqual([{ path: "widgets.0.layout.phone", code: "LAYOUT_OUT_OF_GRID" }]);
    expect(only(table({ layout: layout({ phone: { x: 1 } }) }))).toEqual([{ path: "widgets.0.layout.phone", code: "LAYOUT_OUT_OF_GRID" }]);
    expect(only(table({ layout: layout({ desktop: { w: 2 } }) }))).toEqual([{ path: "widgets.0.layout.desktop", code: "LAYOUT_TOO_SMALL" }]);
    expect(only(table({ layout: layout({ tablet: { h: 3 } }) }))).toEqual([{ path: "widgets.0.layout.tablet", code: "LAYOUT_TOO_SMALL" }]);
    // The least width is limited to the columns of the layout: on the phone one column is enough, and the edges are in.
    expect(validateDesign(design(table({ layout: layout({ phone: { w: 1, h: 4 }, tablet: { w: 3, h: 4 }, desktop: { x: 9, w: 3, h: 4 } }) })), contextOf().context).ok).toBe(true);
  });

  it("the identifiers of widgets: not a UUID version 7, the same twice, one that lives on another screen (but not one of this screen)", () => {
    expect(only(table({ id: "not-an-id" }))).toEqual([{ path: "widgets.0.id", code: "WIDGET_ID_INVALID" }]);
    expect(refusal(design(table(), table()))).toEqual([{ path: "widgets.1.id", code: "WIDGET_ID_DUPLICATE" }]);
    const taken = contextOf(undefined, { [F01_TABLE.id]: OTHER_SCREEN }).context;
    expect(only(table(), taken)).toEqual([{ path: "widgets.0.id", code: "WIDGET_ID_TAKEN" }]);
    const mine = contextOf(undefined, { [F01_TABLE.id]: SCREEN }).context;
    expect(validateDesign(design(table()), mine).ok).toBe(true);
  });

  it("the screen: name, theme, accent and the number of widgets", () => {
    const issues = (patch: Partial<DesignInput>) => refusal({ ...design(table()), ...patch });
    for (const name of ["", "   ", "x".repeat(81), "line\nbreak", "nul\u0000", "sep "]) expect(issues({ name }), JSON.stringify(name)).toEqual([{ path: "name", code: "NAME_INVALID" }]);
    expect(validateDesign({ ...design(table()), name: "x".repeat(80) }, contextOf().context).ok).toBe(true);
    expect(issues({ theme: "light" })).toEqual([{ path: "theme", code: "THEME_UNKNOWN" }]);
    expect(issues({ accent: "red" })).toEqual([{ path: "accent", code: "ACCENT_UNKNOWN" }]);
    const many = Array.from({ length: DESIGN_LIMITS.widgetsPerScreen + 1 }, (_, index) => table({ id: `019a0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}` }));
    expect(refusal(design(...many))).toEqual([{ path: "widgets", code: "LIMIT_WIDGETS" }]);
    expect(validateDesign(design(...many.slice(0, DESIGN_LIMITS.widgetsPerScreen)), contextOf().context).ok).toBe(true);
  });

  it("every defect is returned at once, each at its widget, and no issue carries a value", () => {
    const secret = "Tytuł-tajny-wartość";
    const bad = table({ id: "019a0000-0000-7000-8000-0000000001a3", config: { v: 1, title: secret, pageSize: 0 }, bindings: [{ ...registryBinding(), path: `Field.Register.${secret}` }, columnBinding("tytul", 0)] });
    const issues = refusal({ name: "", theme: "light", accent: "red", widgets: [table(), bad] });
    expect(issues.map((issue) => `${issue.path}:${issue.code}`)).toEqual(["name:NAME_INVALID", "theme:THEME_UNKNOWN", "accent:ACCENT_UNKNOWN", "widgets.1.config:CONFIG_INVALID", "widgets.1.bindings.0.path:PATH_MISMATCH"]);
    expect(JSON.stringify(issues)).not.toContain("tajny");
  });

  it("a hostile snapshot is refused without an exception: keys that look like the prototype, odd characters in paths and names", () => {
    const hostile = table({ bindings: [{ ...registryBinding(), path: "Field.Register.ksiazki'; DROP TABLE reg_ksiazki; --" }, columnBinding("tytul", 0)], config: JSON.parse('{"v":1,"__proto__":{"admin":true},"constructor":"x"}') as Record<string, unknown> });
    const issues = refusal(design(hostile));
    expect(issues).toContainEqual({ path: "widgets.0.bindings.0.path", code: "PATH_MISMATCH" });
    expect(issues).toContainEqual({ path: "widgets.0.config", code: "CONFIG_INVALID" });
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
  });
});
