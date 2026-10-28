// D17.1-AC2 — the catalog of widget types of this build and the contract of the register table
// (Architektura §8): one type, a configuration with defaults and a range, a version that is
// migrated or sent back to the owner, the shape of the bindings a slot takes, and a definition
// that carries no React and no Node.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBindingShape,
  findWidgetDefinition,
  missingRequiredSlots,
  normalizeWidgetConfig,
  registerTableDefinition,
  WIDGET_DEFINITIONS,
  type SlotBinding,
} from "../../../packages/widgets/dist/definitions.js";

const root = path.resolve(import.meta.dirname, "../../..");
const fixture = JSON.parse(readFileSync(path.join(root, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { screens: Array<{ widgets: Array<{ type: string; config: unknown; bindings: SlotBinding[] }> }> };
const F01_TABLE = fixture.screens[0]!.widgets[0]!;
const table = findWidgetDefinition("register-table")!;

const REGISTRY = "019a0000-0000-7000-8000-000000000064";
const binding = (slot: string, ordinal: number, kind: SlotBinding["target"]["kind"] = "column"): SlotBinding => ({
  slot,
  ordinal,
  target: kind === "registry" ? { kind, registryId: REGISTRY } : kind === "column" ? { kind, registryId: REGISTRY, columnId: `019a0000-0000-7000-8000-00000000006${ordinal}` } : kind === "systemColumn" ? { kind, registryId: REGISTRY, symbol: "created_at" } : kind === "config" ? { kind, entryId: REGISTRY } : { kind, symbol: "dzis" },
});

describe("D17.1-AC2 the catalog of this build", () => {
  it("knows the register table and no other type", () => {
    expect(WIDGET_DEFINITIONS.map((definition) => definition.type)).toEqual(["register-table"]);
    expect(findWidgetDefinition("register-table")).toBe(registerTableDefinition);
    for (const other of ["clock", "", "REGISTER-TABLE", "register-table ", "__proto__", "constructor", "../register-table"]) expect(findWidgetDefinition(other), JSON.stringify(other)).toBeNull();
  });

  it("the register table declares a registry, columns and an optional sort column, can add records, and has the sizes of the plan", () => {
    expect(table.slots).toEqual([
      { name: "registry", cardinality: "one", required: true, accepts: ["registry"] },
      { name: "columns", cardinality: "many", required: true, accepts: ["column", "systemColumn"] },
      { name: "sortColumn", cardinality: "one", required: false, accepts: ["column", "systemColumn"] },
    ]);
    expect(table.capabilities).toEqual(["records:add"]);
    expect(table.configVersion).toBe(1);
    expect(table.defaultSize).toEqual({ w: 8, h: 8 });
    expect(table.minSize).toEqual({ w: 3, h: 4 });
    // The source and the columns are bindings only: the configuration has no copy of them.
    expect(Object.keys(registerTableDefinition.configSchema.parse({ v: 1 }))).toEqual(["v", "title", "pageSize", "sortDirection", "allowAdd"]);
  });
});

describe("D17.1-AC2 the configuration of the register table", () => {
  const normalize = (input: unknown) => normalizeWidgetConfig(table, input);

  it("the configuration of F01 passes, and a bare version gets the defaults of the plan", () => {
    expect(normalize(F01_TABLE.config)).toEqual({ ok: true, config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true } });
    expect(normalize({ v: 1 })).toEqual({ ok: true, config: { v: 1, title: "", pageSize: 10, sortDirection: "desc", allowAdd: true } });
    expect(normalize({ v: 1, title: "  Wide  " })).toMatchObject({ ok: true, config: { title: "Wide" } });
  });

  it("the page size is a whole number from 1 to 100, the direction one of two, the switch a boolean, the title up to 80 characters", () => {
    for (const pageSize of [1, 10, 100]) expect(normalize({ v: 1, pageSize }), String(pageSize)).toMatchObject({ ok: true });
    for (const pageSize of [0, 101, -1, 1.5, "10", null, Number.NaN, Number.POSITIVE_INFINITY]) expect(normalize({ v: 1, pageSize }), String(pageSize)).toEqual({ ok: false, code: "INVALID_CONFIG" });
    for (const sortDirection of ["asc", "desc"]) expect(normalize({ v: 1, sortDirection })).toMatchObject({ ok: true });
    for (const sortDirection of ["ASC", "up", "", null, 1]) expect(normalize({ v: 1, sortDirection }), String(sortDirection)).toEqual({ ok: false, code: "INVALID_CONFIG" });
    for (const allowAdd of ["yes", 1, null, "true"]) expect(normalize({ v: 1, allowAdd }), String(allowAdd)).toEqual({ ok: false, code: "INVALID_CONFIG" });
    expect(normalize({ v: 1, allowAdd: false })).toMatchObject({ ok: true, config: { allowAdd: false } });
    expect(normalize({ v: 1, title: "x".repeat(80) })).toMatchObject({ ok: true });
    expect(normalize({ v: 1, title: "x".repeat(81) })).toEqual({ ok: false, code: "INVALID_CONFIG" });
  });

  it("a copy of the source or the columns, or any key the type does not define, is refused", () => {
    for (const extra of [{ columns: ["tytul"] }, { source: "ksiazki" }, { registryId: "x" }, { sortColumn: "created_at" }, { state: "ok" }, { unknown: 1 }]) {
      expect(normalize({ v: 1, ...extra }), JSON.stringify(extra)).toEqual({ ok: false, code: "INVALID_CONFIG" });
    }
  });

  it("a version this build does not write, or none, goes back to the owner instead of being guessed", () => {
    for (const input of [{ title: "no version" }, { v: 2 }, { v: 0 }, { v: "1" }, { v: null }, {}, null, undefined, [], "text", 5]) {
      expect(normalize(input), JSON.stringify(input)).toEqual({ ok: false, code: "NEEDS_REFRESH" });
    }
    expect(table.migrateConfig({ v: 2, anything: 1 })).toBe("needs_refresh");
    expect(table.migrateConfig({ v: 1, title: "x" })).toEqual({ v: 1, title: "x" });
  });

  it("the input is not changed by the migration or the schema", () => {
    const input = { v: 1, title: " keep ", pageSize: 5 };
    const before = JSON.stringify(input);
    normalize(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("D17.1-AC2 the shape of the bindings a slot takes", () => {
  const check = (bindings: SlotBinding[]) => checkBindingShape(table, bindings);

  it("the bindings of F01 are well formed, and a widget with none is well formed too (a draft)", () => {
    expect(check(F01_TABLE.bindings)).toEqual([]);
    expect(check([])).toEqual([]);
    expect(check([binding("registry", 0, "registry"), binding("columns", 0), binding("columns", 1, "systemColumn"), binding("sortColumn", 0, "systemColumn")])).toEqual([]);
  });

  it("an unknown slot, a second binding in a slot of one, a target the slot does not accept, a repeated or skipped ordinal are named with their slot", () => {
    expect(check([binding("rows", 0)])).toEqual([{ slot: "rows", code: "SLOT_UNKNOWN" }]);
    expect(check([binding("registry", 0, "registry"), binding("registry", 1, "registry")])).toContainEqual({ slot: "registry", code: "SLOT_TOO_MANY" });
    expect(check([binding("sortColumn", 0), binding("sortColumn", 1)])).toContainEqual({ slot: "sortColumn", code: "SLOT_TOO_MANY" });
    for (const kind of ["column", "systemColumn", "config", "system"] as const) expect(check([binding("registry", 0, kind)]), kind).toEqual([{ slot: "registry", code: "TARGET_KIND_NOT_ACCEPTED" }]);
    for (const kind of ["registry", "config", "system"] as const) expect(check([binding("columns", 0, kind)]), kind).toEqual([{ slot: "columns", code: "TARGET_KIND_NOT_ACCEPTED" }]);
    expect(check([binding("columns", 0), binding("columns", 0)])).toEqual([{ slot: "columns", code: "ORDINAL_DUPLICATE" }]);
    expect(check([binding("columns", 0), binding("columns", 2)])).toEqual([{ slot: "columns", code: "ORDINAL_GAP" }]);
    expect(check([binding("columns", 1)])).toEqual([{ slot: "columns", code: "ORDINAL_GAP" }]);
    expect(check([binding("columns", 2), binding("columns", 0), binding("columns", 1)])).toEqual([]);
  });

  it("the required slots with no binding are listed, in the order the type declares them", () => {
    expect(missingRequiredSlots(table, [])).toEqual(["registry", "columns"]);
    expect(missingRequiredSlots(table, [binding("registry", 0, "registry")])).toEqual(["columns"]);
    expect(missingRequiredSlots(table, [binding("columns", 0)])).toEqual(["registry"]);
    expect(missingRequiredSlots(table, F01_TABLE.bindings)).toEqual([]);
    expect(missingRequiredSlots(table, [binding("sortColumn", 0)])).toEqual(["registry", "columns"]);
  });
});

describe("D17.1-AC2 a definition carries no React and no Node (AR14)", () => {
  it("the built definitions import only each other, the contracts and zod", () => {
    const dist = path.join(root, "packages/widgets/dist");
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(directory, entry.name)) : entry.name.endsWith(".js") ? [path.join(directory, entry.name)] : []));
    const built = files(dist).filter((file) => !/(views|View)\.js$/.test(file));
    expect(built.length).toBeGreaterThan(4);
    for (const file of built) {
      const specifiers = [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
      for (const specifier of specifiers) expect(specifier.startsWith(".") || specifier === "zod" || specifier.startsWith("@openlife/contracts/"), `${path.relative(dist, file)} imports ${specifier}`).toBe(true);
    }
  });
});
