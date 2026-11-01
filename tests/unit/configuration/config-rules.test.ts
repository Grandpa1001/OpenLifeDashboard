// D25.1 — the rules of an entry of ConfigTable, the values of `Field.System` and the path of a
// binding to an entry (Scope §5.7, §6.1; Architektura §5.3, §14.2, §18.3, Załącznik C), as pure
// functions. The entry of F01 is text and stays the text it was; a number, an overlong value or
// description, a bad or taken symbol and the limit are refused with the path of the field. A day of
// `Field.System` is the owner's day across midnight and a change of the clock. A binding to an entry
// must carry `Field.Config.<symbol>` of an entry of the owner; once that entry is deleted, a stored
// widget is to be bound again, not refreshed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWidgetCatalog } from "../../../apps/server/dist/adapters/widget-catalog.js";
import { DESIGN_LIMITS, GRID_COLUMNS, SCREEN_ACCENTS, SCREEN_THEMES } from "../../../packages/contracts/dist/http/screens.js";
import { DEFAULT_CONFIG_LIMITS, systemFieldValue, validateConfigContent, validateNewConfigEntry } from "../../../packages/core/dist/modules/configuration/public.js";
import { stateOfStoredWidget, validateDesign, type DesignContext, type SlotBinding, type WidgetCatalogPort, type WidgetInput } from "../../../packages/core/dist/modules/dashboard/public.js";

const root = path.resolve(import.meta.dirname, "../../..");
const fixture = JSON.parse(readFileSync(path.join(root, "tests/fixtures/books/books-v1.export.json"), "utf8")) as {
  configEntries: Array<{ id: string; symbol: string; displayName: string; value: string; description: string }>;
  screens: Array<{ widgets: WidgetInput[] }>;
};
const NORMA = fixture.configEntries[0]!;
const draft = (patch: Record<string, unknown> = {}) => ({ symbol: NORMA.symbol, displayName: NORMA.displayName, value: NORMA.value, description: NORMA.description, ...patch });
const fresh = { limits: DEFAULT_CONFIG_LIMITS, takenSymbols: new Set<string>(), count: 0 };
const issuesOf = (result: { ok: true } | { ok: false; issues: readonly unknown[] }) => (result.ok ? [] : result.issues);

describe("D25.1-AC1 the entry of F01 is text", () => {
  it("norma_czytania = \"20\" is accepted as the text it was sent as; a value is never trimmed, and an empty value and description are entries too", () => {
    expect(validateNewConfigEntry(draft(), fresh)).toEqual({ ok: true, value: { symbol: "norma_czytania", displayName: "Norma czytania", value: "20", description: NORMA.description } });
    expect(validateConfigContent({ displayName: "  Norma  ", value: "  20 \n" }, DEFAULT_CONFIG_LIMITS)).toEqual({ ok: true, value: { displayName: "Norma", value: "  20 \n", description: "" } });
    expect(validateConfigContent({ displayName: "Pusta", value: "", description: "" }, DEFAULT_CONFIG_LIMITS).ok).toBe(true);
    // The longest value and description by code points: a Polish letter or an emoji is one.
    expect(validateConfigContent({ displayName: "D", value: "ł".repeat(10_000), description: "😀".repeat(500) }, DEFAULT_CONFIG_LIMITS).ok).toBe(true);
    expect(validateConfigContent({ displayName: "D", value: "x", description: "linia 1\nlinia 2" }, DEFAULT_CONFIG_LIMITS).ok).toBe(true);
  });
});

describe("D25.1-AC2 what an entry may not be", () => {
  it("a value that is not text, too long or malformed, a description that is not text, too long or has control characters, and a bad name", () => {
    for (const value of [20, null, true, ["20"], { v: "20" }, undefined]) expect(issuesOf(validateNewConfigEntry(draft({ value }), fresh)), JSON.stringify(value)).toEqual([{ path: "value", code: "VALUE_NOT_TEXT" }]);
    expect(issuesOf(validateNewConfigEntry(draft({ value: "ł".repeat(10_001) }), fresh))).toEqual([{ path: "value", code: "VALUE_TOO_LONG" }]);
    expect(issuesOf(validateNewConfigEntry(draft({ value: "a\uD800b" }), fresh))).toEqual([{ path: "value", code: "VALUE_INVALID" }]);
    expect(issuesOf(validateNewConfigEntry(draft({ description: 5 }), fresh))).toEqual([{ path: "description", code: "DESCRIPTION_NOT_TEXT" }]);
    expect(issuesOf(validateNewConfigEntry(draft({ description: "x".repeat(501) }), fresh))).toEqual([{ path: "description", code: "DESCRIPTION_TOO_LONG" }]);
    for (const description of ["tab\there", "bell\u0007", "line sep", "a\uDC00"]) expect(issuesOf(validateNewConfigEntry(draft({ description }), fresh)), JSON.stringify(description)).toEqual([{ path: "description", code: "DESCRIPTION_INVALID" }]);
    expect(issuesOf(validateNewConfigEntry(draft({ displayName: "   " }), fresh))).toEqual([{ path: "displayName", code: "NAME_EMPTY" }]);
    expect(issuesOf(validateConfigContent("20", DEFAULT_CONFIG_LIMITS))).toEqual([{ path: "displayName", code: "NAME_EMPTY" }, { path: "value", code: "VALUE_NOT_TEXT" }]);
  });

  it("a bad, long or taken symbol, and the limit of entries; a symbol is in the space of the entries only", () => {
    for (const symbol of ["Norma", "1norma", "norma__czytania", "norma_", "", 7]) expect(issuesOf(validateNewConfigEntry(draft({ symbol }), fresh)), JSON.stringify(symbol)).toEqual([{ path: "symbol", code: "SYMBOL_PATTERN" }]);
    expect(issuesOf(validateNewConfigEntry(draft({ symbol: "a".repeat(41) }), fresh))).toEqual([{ path: "symbol", code: "SYMBOL_TOO_LONG" }]);
    expect(issuesOf(validateNewConfigEntry(draft(), { ...fresh, takenSymbols: new Set(["norma_czytania"]) }))).toEqual([{ path: "symbol", code: "SYMBOL_TAKEN" }]);
    // The reserved words are those of the columns of a registry: an entry may be called `id`.
    expect(validateNewConfigEntry(draft({ symbol: "id" }), fresh).ok).toBe(true);
    expect(issuesOf(validateNewConfigEntry(draft(), { ...fresh, count: 500 }))).toEqual([{ path: "entry", code: "LIMIT_ENTRIES" }]);
    expect(validateNewConfigEntry(draft(), { ...fresh, count: 499 }).ok).toBe(true);
  });
});

describe("D25.1-AC1 Field.System", () => {
  const at = (iso: string, timeZone = "Europe/Warsaw") => ({ nowMs: Date.parse(iso), timeZone, locale: "pl", appVersion: "0.4.0" });

  it("today and yesterday are the days of the owner's zone, across midnight and the changes of the clock", () => {
    // 23:30 UTC on 31 December is already 1 January in Warsaw, still 31 December in New York.
    expect(systemFieldValue("dzis", at("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(systemFieldValue("wczoraj", at("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
    expect(systemFieldValue("dzis", at("2026-12-31T23:30:00Z", "America/New_York"))).toBe("2026-12-31");
    // The day of 23 hours (29 March 2026) and of 25 hours (25 October 2026) in Warsaw: yesterday is one calendar day back.
    expect(systemFieldValue("dzis", at("2026-03-29T22:30:00Z"))).toBe("2026-03-30");
    expect(systemFieldValue("wczoraj", at("2026-03-29T22:30:00Z"))).toBe("2026-03-29");
    expect(systemFieldValue("dzis", at("2026-10-25T22:59:00Z"))).toBe("2026-10-25");
    expect(systemFieldValue("wczoraj", at("2026-10-25T22:59:00Z"))).toBe("2026-10-24");
    expect(systemFieldValue("wczoraj", at("2027-03-01T10:00:00Z"))).toBe("2027-02-28");
  });

  it("now is the instant in UTC; the zone, the language and the version are the owner's and the build's", () => {
    expect(systemFieldValue("teraz", at("2026-11-01T12:34:56.789Z"))).toBe("2026-11-01T12:34:56.789Z");
    expect([systemFieldValue("strefa", at("2026-11-01T00:00:00Z")), systemFieldValue("jezyk", at("2026-11-01T00:00:00Z")), systemFieldValue("wersja", at("2026-11-01T00:00:00Z"))]).toEqual(["Europe/Warsaw", "pl", "0.4.0"]);
  });
});

describe("D25.1-AC2 a binding to an entry of ConfigTable", () => {
  const OWNER = "owner-1";
  const ENTRY = NORMA.id;
  const table = fixture.screens[0]!.widgets[0]!;
  const registryTarget = table.bindings[0]!.target;
  const BOOKS_ID = registryTarget.kind === "registry" ? registryTarget.registryId : "";
  const real = createWidgetCatalog();
  /** The real catalog, with one future type stood in for: `register-table` taking an entry in a slot of its own. */
  const widgets: WidgetCatalogPort = {
    ...real,
    has: (type) => real.has(type),
    normalizeConfig: (type, input) => real.normalizeConfig(type, input),
    missingRequiredSlots: (type, bindings) => real.missingRequiredSlots(type, bindings.filter((binding) => binding.slot !== "norm")),
    minSize: (type) => real.minSize(type),
    describe: () => real.describe(),
    bindingProblems: (type, bindings) => real.bindingProblems(type, bindings.filter((binding) => binding.slot !== "norm")),
  };
  const contextOf = (entries: Record<string, string>, catalog: WidgetCatalogPort = widgets): DesignContext => ({
    ownerId: OWNER,
    screenId: "019a0000-0000-7000-8000-000000000190",
    policy: { maxWidgets: DESIGN_LIMITS.widgetsPerScreen, maxBindingsPerWidget: DESIGN_LIMITS.bindingsPerWidget, maxWidgetJsonBytes: DESIGN_LIMITS.widgetJsonBytes, nameMaxChars: DESIGN_LIMITS.nameMaxChars, themes: SCREEN_THEMES, accents: SCREEN_ACCENTS, gridColumns: GRID_COLUMNS },
    widgets: catalog,
    catalog: {
      registry: (owner, id) => (owner === OWNER && id === BOOKS_ID ? { id, symbol: "ksiazki", deleted: false, columns: table.bindings.flatMap((binding) => (binding.target.kind === "column" ? [{ id: binding.target.columnId, symbol: binding.path.split(".").at(-1)!, deleted: false }] : [])) } : null),
      configEntry: (owner, id) => (owner === OWNER && Object.hasOwn(entries, id) ? { symbol: entries[id]! } : null),
      screenOfWidget: () => null,
    },
  });
  const withNorm = (binding: Partial<SlotBinding> = {}): WidgetInput => ({ ...structuredClone(table), bindings: [...structuredClone(table.bindings), { slot: "norm", ordinal: 0, path: "Field.Config.norma_czytania", target: { kind: "config", entryId: ENTRY }, ...binding }] });
  const design = (widget: WidgetInput) => ({ name: "Ekran", theme: "dark", accent: "blue", widgets: [widget] });
  const issues = (widget: WidgetInput, entries: Record<string, string> = { [ENTRY]: "norma_czytania" }, catalog?: WidgetCatalogPort) => {
    const result = validateDesign(design(widget), contextOf(entries, catalog));
    return result.ok ? [] : result.issues;
  };
  const at = (index: number, field: string) => `widgets.0.bindings.${index}.${field}`;
  const NORM = table.bindings.length;

  it("is accepted with the path Field.Config.<symbol> of an entry of the owner, and refused with another path or an entry the owner has not", () => {
    expect(issues(withNorm())).toEqual([]);
    expect(issues(withNorm({ path: "Field.Config.norma" }))).toEqual([{ path: at(NORM, "path"), code: "PATH_MISMATCH" }]);
    expect(issues(withNorm({ path: "Field.System.dzis" }))).toEqual([{ path: at(NORM, "path"), code: "PATH_MISMATCH" }]);
    expect(issues(withNorm(), {})).toEqual([{ path: at(NORM, "target"), code: "TARGET_UNKNOWN" }]);
  });

  it("the register table of this build takes no entry: the Designer has nothing of ConfigTable to offer it", () => {
    expect(issues(withNorm({ slot: "columns", ordinal: table.bindings.filter((binding) => binding.slot === "columns").length }), { [ENTRY]: "norma_czytania" }, real)).toContainEqual({ path: "widgets.0.bindings", code: "TARGET_KIND_NOT_ACCEPTED" });
    for (const manifest of real.describe()) for (const slot of manifest.slots) expect(slot.accepts, `${manifest.type}.${slot.name}`).not.toContain("config");
    for (const manifest of real.describe()) for (const slot of manifest.slots) expect(slot.accepts, `${manifest.type}.${slot.name}`).not.toContain("system");
  });

  it("a stored widget whose entry was deleted since is to be bound again", () => {
    expect(stateOfStoredWidget(withNorm(), contextOf({ [ENTRY]: "norma_czytania" }))).toBe("ok");
    expect(stateOfStoredWidget(withNorm(), contextOf({}))).toBe("needs_rebinding");
  });
});
