// D47.2 — the import of the template of a screen over HTTP (Architektura Załącznik G; DEV §9.44).
// AC1: a template from installation A in installation B: new identifiers, the paths resolved by symbol, a path that
//      names nothing keeps itself and the widget needs rebinding, a type this build lacks is kept and needs a
//      refresh; the saved result is saved again by the Designer without a refusal.
// AC2: a defective file is 422 with paths and codes and no value, a failing write or audit leaves the screen as it
//      was, and the audit holds counts only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { screenTemplateSchema, type ScreenTemplate } from "@openlife/contracts/export/screen-template";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { REGISTRIES_PATH, registryListSchema, type RegistryDto } from "@openlife/contracts/http/registries";
import { SCREENS_PATH, screenDesignPath, screenPath, screenSchema, screenTemplatePath, widgetDataPath, widgetDataSchema, type ScreenDto } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses } from "../../support/app-harness.ts";
import { withoutDictionary } from "../../support/books-fixture.ts";
import { repoRoot } from "../../support/server-process.ts";
import { createSignedInHarness } from "../../support/signed-in-harness.ts";

afterEach(() => closeHarnesses());

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[] }> };
const BOOKS = fixture.registries[0]!;
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WIDGET = "019a0000-0000-7000-8000-00000000019a";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 8, h: 8 } };
/** A widget as the Designer sends it: what the server read, without the state that is the server's. */
const withoutState = (widget: ScreenDto["widgets"][number]) => ({ id: widget.id, type: widget.type, config: widget.config, layout: widget.layout, bindings: widget.bindings });
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const issuesOf = (reply: { json: () => unknown }): string[] => ((apiErrorSchema.parse(reply.json()).details as { issues: Array<{ path: string; code: string }> }).issues).map((issue) => `${issue.path}:${issue.code}`);

const booksRequest = (without: readonly string[] = []) => ({
  symbol: BOOKS.symbol,
  displayName: BOOKS.displayName,
  columns: BOOKS.columns.filter((column) => !without.includes(column.symbol)).map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })),
});

/** An installation with a screen; with the registry of F01 unless `without` leaves out columns or `registry` is false. */
async function installation(options: { registry?: boolean; without?: readonly string[] } = {}) {
  const { h, cookie } = await createSignedInHarness();
  let registry: RegistryDto | null = null;
  if (options.registry !== false) {
    expect((await h.request("POST", REGISTRIES_PATH, booksRequest(options.without), { cookie })).status).toBe(201);
    registry = registryListSchema.parse((await h.request("GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries[0]!;
  }
  const screen = screenSchema.parse((await h.request("POST", SCREENS_PATH, { name: "Ekran" }, { cookie })).json());
  const get = async (): Promise<ScreenDto> => screenSchema.parse((await h.request("GET", screenPath(screen.id), undefined, { cookie })).json());
  const importTemplate = (file: unknown) => h.request("POST", screenTemplatePath(screen.id), file, { cookie });
  const audit = (action: string) => h.rows<{ details: string | null }>(`SELECT details FROM audit_log WHERE action = '${action}'`);
  return { h, cookie, registry, screen, get, importTemplate, audit };
}

/** The template installation A makes of a screen with the table of F01. */
async function templateOfA(): Promise<ScreenTemplate> {
  const a = await installation();
  const registry = a.registry!;
  const column = (symbol: string) => registry.columns.find((candidate) => candidate.symbol === symbol)!;
  const table = {
    id: WIDGET,
    type: "register-table",
    config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true },
    layout: LAYOUT,
    bindings: [
      { slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: registry.id } },
      { slot: "columns", ordinal: 0, path: "Field.Register.ksiazki.tytul", target: { kind: "column", registryId: registry.id, columnId: column("tytul").id } },
      { slot: "columns", ordinal: 1, path: "Field.Register.ksiazki.autor", target: { kind: "column", registryId: registry.id, columnId: column("autor").id } },
      { slot: "sortColumn", ordinal: 0, path: "Field.Register.ksiazki.created_at", target: { kind: "systemColumn", registryId: registry.id, symbol: "created_at" } },
    ],
  };
  expect((await a.h.request("PUT", screenDesignPath(a.screen.id), { name: "Z szablonu", theme: "dark", accent: "violet", widgets: [table] }, { cookie: a.cookie })).status).toBe(200);
  const file = screenTemplateSchema.parse((await a.h.request("GET", screenTemplatePath(a.screen.id), undefined, { cookie: a.cookie })).json());
  closeHarnesses();
  return file;
}

describe("D47.2-AC1 a template from A in B", () => {
  it("makes new identifiers, resolves the paths by symbol, replaces the name, the accent and the widgets, and the data reads", async () => {
    const template = await templateOfA();
    const b = await installation();
    // B has a widget of its own that the template replaces.
    const own = { id: "019a0000-0000-7000-8000-0000000001b0", type: "register-table", config: { v: 1, title: "Własny" }, layout: LAYOUT, bindings: [{ slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: b.registry!.id } }] };
    expect((await b.h.request("PUT", screenDesignPath(b.screen.id), { name: "Ekran", theme: "dark", accent: "blue", widgets: [own] }, { cookie: b.cookie })).status).toBe(200);

    const reply = await b.importTemplate(template);
    expect(reply.status).toBe(200);
    const screen = screenSchema.parse(reply.json());
    expect(screen).toMatchObject({ id: b.screen.id, name: "Z szablonu", accent: "violet" });
    expect(screen.widgets).toHaveLength(1);
    const widget = screen.widgets[0]!;
    expect(widget.id).toMatch(V7);
    expect([WIDGET, own.id]).not.toContain(widget.id);
    expect(widget).toMatchObject({ type: "register-table", state: "ok", config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true }, layout: LAYOUT });
    // The targets are those of B, found by symbol.
    const registry = b.registry!;
    expect(widget.bindings.find((binding) => binding.slot === "registry")!.target).toEqual({ kind: "registry", registryId: registry.id });
    expect(widget.bindings.find((binding) => binding.path.endsWith(".autor"))!.target).toEqual({ kind: "column", registryId: registry.id, columnId: registry.columns.find((column) => column.symbol === "autor")!.id });
    expect(await b.get()).toEqual(screen);
    const data = widgetDataSchema.parse((await b.h.request("GET", widgetDataPath(widget.id), undefined, { cookie: b.cookie })).json());
    expect(data).toMatchObject({ state: "ok", registry: { symbol: "ksiazki" } });
    expect(data.columns.map((column) => column.key)).toEqual(["tytul", "autor"]);
    // The Designer saves what it read, whole, and is not refused.
    expect((await b.h.request("PUT", screenDesignPath(b.screen.id), { name: screen.name, theme: screen.theme, accent: screen.accent, widgets: screen.widgets.map((widget) => withoutState(widget)) }, { cookie: b.cookie })).status).toBe(200);
    expect(b.audit("screen.template_imported").map((row) => JSON.parse(row.details ?? "{}"))).toEqual([{ widgets: 1, needsRebinding: 0, needsRefresh: 0 }]);
  });

  it("keeps a path that names nothing here as a broken binding, so the widget needs rebinding and shows the path, and a design that carries it back is saved", async () => {
    const template = await templateOfA();
    const b = await installation({ without: ["autor"] });
    const reply = await b.importTemplate(template);
    expect(reply.status).toBe(200);
    const screen = screenSchema.parse(reply.json());
    const widget = screen.widgets[0]!;
    expect(widget.state).toBe("needs_rebinding");
    const missing = widget.bindings.find((binding) => binding.path === "Field.Register.ksiazki.autor")!;
    expect(missing.target).toMatchObject({ kind: "column", registryId: b.registry!.id });
    expect(b.registry!.columns.map((column) => column.id)).not.toContain((missing.target as { columnId: string }).columnId);
    const data = widgetDataSchema.parse((await b.h.request("GET", widgetDataPath(widget.id), undefined, { cookie: b.cookie })).json());
    expect(data).toMatchObject({ state: "needs_rebinding", rows: [], total: 0 });
    expect(b.audit("screen.template_imported").map((row) => JSON.parse(row.details ?? "{}"))).toEqual([{ widgets: 1, needsRebinding: 1, needsRefresh: 0 }]);

    // Autosave of the same widget, moved, goes through; the same broken target on a new widget is refused as it always was.
    const rest = screen.widgets.map((widget) => ({ ...withoutState(widget), layout: { ...LAYOUT, desktop: { x: 2, y: 0, w: 8, h: 8 } } }));
    const design = (widgets: unknown[]) => ({ name: screen.name, theme: screen.theme, accent: screen.accent, widgets });
    expect((await b.h.request("PUT", screenDesignPath(b.screen.id), design(rest), { cookie: b.cookie })).status).toBe(200);
    const added = { ...rest[0]!, id: "019a0000-0000-7000-8000-0000000001c0" };
    const refused = await b.h.request("PUT", screenDesignPath(b.screen.id), design([...rest, added]), { cookie: b.cookie });
    expect(refused.status).toBe(422);
    expect(issuesOf(refused)).toContain("widgets.1.bindings.2.target:TARGET_UNKNOWN");
  });

  it("makes a registry that is not there at all one missing registry for every binding to it", async () => {
    const template = await templateOfA();
    const b = await installation({ registry: false });
    const screen = screenSchema.parse((await b.importTemplate(template)).json());
    const widget = screen.widgets[0]!;
    expect(widget.state).toBe("needs_rebinding");
    expect(widget.bindings.map((binding) => binding.path)).toEqual(["Field.Register.ksiazki", "Field.Register.ksiazki.tytul", "Field.Register.ksiazki.autor", "Field.Register.ksiazki.created_at"]);
    expect(new Set(widget.bindings.map((binding) => (binding.target as { registryId: string }).registryId)).size).toBe(1);
  });

  it("keeps a widget of a type this build lacks, with its configuration, and reads and runs nothing of it", async () => {
    const b = await installation();
    const file = { format: "openlifedashboard-screen-template", formatVersion: 1, appVersion: "9.9.9", exportedAt: new Date().toISOString(), screen: { name: "Obcy", theme: "dark", accent: "teal", widgets: [{ type: "weather", config: { v: 3, city: "Kraków", script: "alert(1)" }, layout: LAYOUT, bindings: [] }] } };
    const reply = await b.importTemplate(file);
    expect(reply.status).toBe(200);
    const widget = screenSchema.parse(reply.json()).widgets[0]!;
    expect(widget).toMatchObject({ type: "weather", state: "needs_refresh", config: { v: 3, city: "Kraków", script: "alert(1)" } });
    expect(widgetDataSchema.parse((await b.h.request("GET", widgetDataPath(widget.id), undefined, { cookie: b.cookie })).json())).toMatchObject({ state: "needs_refresh", rows: [], total: 0 });
    const saved = await b.h.request("PUT", screenDesignPath(b.screen.id), { name: "Obcy", theme: "dark", accent: "teal", widgets: [{ id: widget.id, type: widget.type, config: widget.config, layout: widget.layout, bindings: widget.bindings }] }, { cookie: b.cookie });
    expect(saved.status).toBe(200);
    expect(b.audit("screen.template_imported").map((row) => JSON.parse(row.details ?? "{}"))).toEqual([{ widgets: 1, needsRebinding: 0, needsRefresh: 1 }]);
  });
});

describe("D47.2-AC2 what is refused and what is left behind", () => {
  const valid = (widgets: unknown[] = []) => ({ format: "openlifedashboard-screen-template", formatVersion: 1, appVersion: "0.0.0", exportedAt: new Date().toISOString(), screen: { name: "Nowy", theme: "dark", accent: "blue", widgets } });
  const table = (bindings: unknown[], layout: unknown = LAYOUT) => ({ type: "register-table", config: { v: 1, title: "x" }, layout, bindings });

  it("a file that is not a template, a path that is no path of a field and a layout outside the grid are 422 with paths and codes and the screen is as it was", async () => {
    const b = await installation();
    const before = await b.get();
    const refused = async (file: unknown) => b.importTemplate(file);
    for (const file of [{ ...valid(), format: "openlifedashboard-export" }, { ...valid(), formatVersion: 2 }, { ...valid(), extra: 1 }, { ...valid(), screen: { ...valid().screen, id: "x" } }, "not an object"]) {
      const reply = await refused(file);
      expect([JSON.stringify(file).slice(0, 40), reply.status]).toEqual([JSON.stringify(file).slice(0, 40), 422]);
    }
    const badPath = await refused(valid([table([{ slot: "registry", ordinal: 0, path: "Field.Nothing.here" }])]));
    expect([badPath.status, issuesOf(badPath)]).toEqual([422, ["widgets.0.bindings.0.path:PATH_INVALID"]]);
    const wide = await refused(valid([table([], { ...LAYOUT, desktop: { x: 8, y: 0, w: 8, h: 8 } })]));
    expect([wide.status, issuesOf(wide)]).toEqual([422, ["widgets.0.layout.desktop:LAYOUT_OUT_OF_GRID"]]);
    expect(badPath.text).not.toContain("Nothing");
    expect(await b.get()).toEqual(before);
    expect(b.audit("screen.template_imported")).toEqual([]);
  });

  it("is refused for a screen that is not there, without a session and from a foreign origin", async () => {
    const b = await installation();
    const missing = await b.h.request("POST", screenTemplatePath("019a0000-0000-7000-8000-0000000009ff"), valid(), { cookie: b.cookie });
    expect([missing.status, code(missing)]).toEqual([404, "NOT_FOUND"]);
    const anonymous = await b.h.request("POST", screenTemplatePath(b.screen.id), valid(), { cookie: null });
    expect([anonymous.status, code(anonymous)]).toEqual([401, "AUTH_REQUIRED"]);
    const foreign = await b.h.request("POST", screenTemplatePath(b.screen.id), valid(), { cookie: b.cookie, origin: "https://evil.example" });
    expect([foreign.status, code(foreign)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
  });

  it("a failing write or audit gives 503 and the screen as it was, and the same file works once they do", async () => {
    const b = await installation();
    const before = await b.get();
    const file = valid([table([{ slot: "registry", ordinal: 0, path: "Field.Register.ksiazki" }])]);
    b.h.sql("CREATE TRIGGER fail_widget BEFORE INSERT ON widget BEGIN SELECT RAISE(ABORT, 'disk unavailable: secret-detail'); END;");
    const failed = await b.importTemplate(file);
    expect(failed.status).toBe(503);
    expect(failed.text).not.toContain("secret-detail");
    expect(await b.get()).toEqual(before);
    b.h.sql("DROP TRIGGER fail_widget");
    b.h.sql("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN new.action = 'screen.template_imported' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
    expect((await b.importTemplate(file)).status).toBe(503);
    expect(await b.get()).toEqual(before);
    b.h.sql("DROP TRIGGER fail_audit");
    expect((await b.importTemplate(file)).status).toBe(200);
  });
});
