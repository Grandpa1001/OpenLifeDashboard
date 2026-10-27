// D17.1-AC1 — the snapshot of a screen as the contract takes it (Architektura §18.5): the screen
// of F01 passes, what the server alone may decide (a state, an owner) is refused wherever it is
// sent, and the limits of a widget hold on their edge.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCENT_NAMES } from "../../../packages/ui/dist/index.js";
import {
  DESIGN_LIMITS,
  designSnapshotSchema,
  fieldRefSchema,
  GRID_COLUMNS,
  SCREEN_ACCENTS,
  slotBindingSchema,
  type DesignSnapshotDto,
} from "../../../packages/contracts/dist/http/screens.js";

const fixture = JSON.parse(readFileSync(path.join(path.resolve(import.meta.dirname, "../../.."), "tests/fixtures/books/books-v1.export.json"), "utf8")) as { screens: Array<{ id: string } & DesignSnapshotDto> };
/** The screen of the export without its identifier: the server names a screen, the snapshot does not. */
const F01_SCREEN = Object.fromEntries(Object.entries(fixture.screens[0]!).filter(([key]) => key !== "id")) as unknown as DesignSnapshotDto;
const tableOf = (screen: DesignSnapshotDto) => screen.widgets.find((widget) => widget.type === "register-table")!;
const clone = <T>(value: T): T => structuredClone(value);
const parses = (value: unknown): boolean => designSnapshotSchema.safeParse(value).success;

describe("D17.1-AC1 the snapshot of the screen of F01", () => {
  it("the screen of F01 passes as it stands, with its bindings of every kind it uses", () => {
    const parsed = designSnapshotSchema.parse(F01_SCREEN);
    expect(parsed.widgets.map((widget) => widget.type)).toEqual(["register-table", "clock", "clock"]);
    expect(tableOf(parsed).bindings.map((binding) => [binding.slot, binding.ordinal, binding.target.kind])).toEqual([
      ["registry", 0, "registry"],
      ["columns", 0, "column"],
      ["columns", 1, "column"],
      ["columns", 2, "column"],
      ["sortColumn", 0, "systemColumn"],
    ]);
  });

  it("the one theme, the six accents (the same names as the tokens of the web app) and the grid of three layouts", () => {
    expect([...SCREEN_ACCENTS].sort()).toEqual([...ACCENT_NAMES].sort());
    expect(GRID_COLUMNS).toEqual({ phone: 1, tablet: 8, desktop: 12 });
    for (const accent of SCREEN_ACCENTS) expect(parses({ ...F01_SCREEN, accent })).toBe(true);
    for (const bad of ["red", "BLUE", "", "#5B8DEF", null]) expect(parses({ ...F01_SCREEN, accent: bad }), String(bad)).toBe(false);
    for (const bad of ["light", "dark ", "", null]) expect(parses({ ...F01_SCREEN, theme: bad }), String(bad)).toBe(false);
  });

  it("a field the server alone decides is refused wherever it is sent: the screen, the widget, the layout, the binding and its target", () => {
    const withExtra = (edit: (screen: DesignSnapshotDto) => void): DesignSnapshotDto => {
      const screen = clone(F01_SCREEN);
      edit(screen);
      return screen;
    };
    const attempts: Array<[string, DesignSnapshotDto]> = [
      ["state on the widget", withExtra((screen) => Object.assign(tableOf(screen), { state: "ok" }))],
      ["owner on the widget", withExtra((screen) => Object.assign(tableOf(screen), { ownerId: "someone-else" }))],
      ["owner on the screen", withExtra((screen) => Object.assign(screen, { ownerId: "someone-else" }))],
      ["id on the screen", withExtra((screen) => Object.assign(screen, { id: "019a0000-0000-7000-8000-000000000190" }))],
      ["revision on the screen", withExtra((screen) => Object.assign(screen, { revision: 3 }))],
      ["large layout", withExtra((screen) => Object.assign(tableOf(screen).layout, { large: { x: 0, y: 0, w: 4, h: 4 } }))],
      ["extra key of a layout", withExtra((screen) => Object.assign(tableOf(screen).layout.desktop, { z: 1 }))],
      ["state on a binding", withExtra((screen) => Object.assign(tableOf(screen).bindings[0]!, { state: "ok" }))],
      ["owner on a target", withExtra((screen) => Object.assign(tableOf(screen).bindings[0]!.target, { ownerId: "x" }))],
      ["table name on a target", withExtra((screen) => Object.assign(tableOf(screen).bindings[1]!.target, { tableName: "user" }))],
    ];
    for (const [name, screen] of attempts) expect(parses(screen), name).toBe(false);
  });

  it("an identifier is a UUID version 7, a target is one of five kinds, an ordinal and a rectangle are whole numbers in range", () => {
    const registryId = "019a0000-0000-7000-8000-000000000064";
    for (const bad of ["", "not-an-id", "019a0000-0000-4000-8000-000000000064", "019a0000-0000-7000-c000-000000000064", registryId.toUpperCase(), `${registryId} `, "../etc/passwd"]) {
      expect(fieldRefSchema.safeParse({ kind: "registry", registryId: bad }).success, bad).toBe(false);
    }
    expect(fieldRefSchema.safeParse({ kind: "registry", registryId }).success).toBe(true);
    expect(fieldRefSchema.safeParse({ kind: "table", name: "user" }).success).toBe(false);
    expect(fieldRefSchema.safeParse({ kind: "systemColumn", registryId, symbol: "user_id" }).success).toBe(false);
    expect(fieldRefSchema.safeParse({ kind: "system", symbol: "dzis" }).success).toBe(true);
    expect(fieldRefSchema.safeParse({ kind: "system", symbol: "password" }).success).toBe(false);
    expect(fieldRefSchema.safeParse({ kind: "config", entryId: registryId }).success).toBe(true);

    const binding = { slot: "columns", ordinal: 0, path: "Field.Register.ksiazki.tytul", target: { kind: "registry", registryId } };
    expect(slotBindingSchema.safeParse(binding).success).toBe(true);
    for (const patch of [{ ordinal: -1 }, { ordinal: 64 }, { ordinal: 1.5 }, { ordinal: "0" }, { slot: "" }, { path: "" }, { path: "x".repeat(301) }, { slot: "x".repeat(41) }]) {
      expect(slotBindingSchema.safeParse({ ...binding, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
    for (const patch of [{ w: 0 }, { h: 0 }, { x: -1 }, { y: 0.5 }, { w: 100 }, { x: "0" }]) {
      const screen = clone(F01_SCREEN);
      Object.assign(tableOf(screen).layout.desktop, patch);
      expect(parses(screen), JSON.stringify(patch)).toBe(false);
    }
  });

  it("a name is trimmed text of 1 to 80 characters, a widget type is a plain name, a configuration carries its version", () => {
    expect(designSnapshotSchema.parse({ ...F01_SCREEN, name: "  Ekran  " }).name).toBe("Ekran");
    for (const bad of ["", "   ", "x".repeat(81), 5]) expect(parses({ ...F01_SCREEN, name: bad }), String(bad)).toBe(false);
    expect(parses({ ...F01_SCREEN, name: "x".repeat(80) })).toBe(true);
    for (const bad of ["", "Register-Table", "../x", "register table", "x".repeat(65), "1table"]) {
      const screen = clone(F01_SCREEN);
      tableOf(screen).type = bad;
      expect(parses(screen), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [{}, { title: "no version" }, { v: 0 }, { v: "1" }, { v: 1.5 }, { v: 1001 }, null, [], "text"]) {
      const screen = clone(F01_SCREEN);
      Object.assign(tableOf(screen), { config: bad });
      expect(parses(screen), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("D17.1-AC1 the limits of a screen and of a widget, on their edge", () => {
  const configOfBytes = (bytes: number) => {
    const base = JSON.stringify({ v: 1, title: "" });
    return { v: 1, title: "x".repeat(bytes - base.length) };
  };

  it("a configuration of 32 KiB passes and one byte more does not; counted in UTF-8", () => {
    const at = (config: unknown) => {
      const screen = clone(F01_SCREEN);
      Object.assign(tableOf(screen), { config });
      return designSnapshotSchema.safeParse(screen).success;
    };
    expect(JSON.stringify(configOfBytes(DESIGN_LIMITS.widgetJsonBytes)).length).toBe(DESIGN_LIMITS.widgetJsonBytes);
    expect(at(configOfBytes(DESIGN_LIMITS.widgetJsonBytes))).toBe(true);
    expect(at(configOfBytes(DESIGN_LIMITS.widgetJsonBytes + 1))).toBe(false);
    // 11 000 characters of three bytes each are 33 000 bytes: over the limit though under it in characters.
    expect(at({ v: 1, title: "€".repeat(11_000) })).toBe(false);
    expect(at({ v: 1, title: "€".repeat(10_000) })).toBe(true);
  });

  it("50 widgets pass and 51 do not; 64 bindings pass and 65 do not", () => {
    const widgets = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...clone(tableOf(F01_SCREEN)), id: `019a0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}` }));
    expect(parses({ ...F01_SCREEN, widgets: widgets(DESIGN_LIMITS.widgetsPerScreen) })).toBe(true);
    expect(parses({ ...F01_SCREEN, widgets: widgets(DESIGN_LIMITS.widgetsPerScreen + 1) })).toBe(false);
    const withBindings = (count: number) => {
      const screen = clone(F01_SCREEN);
      tableOf(screen).bindings = Array.from({ length: count }, (_, ordinal) => ({ ...tableOf(F01_SCREEN).bindings[1]!, ordinal: Math.min(ordinal, 63) }));
      return screen;
    };
    expect(parses(withBindings(DESIGN_LIMITS.bindingsPerWidget))).toBe(true);
    expect(parses(withBindings(DESIGN_LIMITS.bindingsPerWidget + 1))).toBe(false);
  });

  it("a snapshot that is not an object is refused, and so is one with nothing but a name", () => {
    for (const bad of [null, [], "x", 5, {}, { name: "x" }, { ...F01_SCREEN, widgets: null }, { ...F01_SCREEN, widgets: {} }]) expect(parses(bad), JSON.stringify(bad)?.slice(0, 40)).toBe(false);
    expect(parses({ ...F01_SCREEN, widgets: [] })).toBe(true);
  });
});
