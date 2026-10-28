// D17.3 — the screen, its widgets and their bindings on a real SQLite file (Architektura §4.2, §5.6,
// §18.5). The adapters are the production ones and the rules are the real ones with the real catalog
// of widget types; the use case of D17.4 is stood in for by the composition the test writes: the rules
// first, then the store, in one unit.
// AC1: the screen of F01 is written and read back equal, also after a restart; a replacement removes
//      the widgets that are not in the new design with their bindings and keeps the others under the
//      same identifiers; the catalog reader sees deleted columns, and the state of a stored widget
//      follows the catalog without a write.
// AC2: a failure in the middle of a replacement leaves the screen as it was; no identifier of another
//      screen or owner is taken over, by the rules or by the store alone; the tables refuse by
//      themselves what is not a screen, a widget or a binding.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createWidgetCatalog } from "../../../apps/server/dist/adapters/widget-catalog.js";
import { DESIGN_LIMITS, GRID_COLUMNS, SCREEN_ACCENTS, SCREEN_THEMES } from "../../../packages/contracts/dist/http/screens.js";
import {
  stateOfStoredWidget,
  validateDesign,
  type CheckedDesign,
  type DesignContext,
  type DesignInput,
  type DesignIssue,
  type DesignPolicy,
  type StoredScreen,
  type WidgetInput,
} from "../../../packages/core/dist/modules/dashboard/public.js";
import { DEFAULT_REGISTRY_LIMITS, validateNewRegistry, type RegistryDraft } from "../../../packages/core/dist/modules/registries/public.js";
import { bindCatalogReader, bindDashboardStore } from "../../../packages/sqlite/dist/adapters/dashboard/public.js";
import { bindRegistryStore } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, migrateDatabase, PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { afterEach, describe, expect, it } from "vitest";
import { closeRigs, createIdentityRig, done, type IdentityRig } from "../../support/identity-rig.ts";
import { scratchDir } from "../../support/scratch.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(closeRigs);

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean; position: number };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as {
  registries: Array<{ id: string; symbol: string; displayName: string; columns: FixtureColumn[] }>;
  screens: Array<{ id: string; name: string; theme: string; accent: string; widgets: WidgetInput[] }>;
};
const BOOKS = fixture.registries[0]!;
const F01_TABLE = fixture.screens[0]!.widgets[0]!;
const OWNER = "owner-1";
const OTHER = "owner-2";
const SCREEN = fixture.screens[0]!.id;
const SCREEN_2 = "019a0000-0000-7000-8000-0000000002a0";
const NOW = "2026-10-28T12:00:00.000Z";
const LATER = "2026-10-28T12:05:00.000Z";
const SECOND_TABLE = "019a0000-0000-7000-8000-0000000001a1";

const policy: DesignPolicy = {
  maxWidgets: DESIGN_LIMITS.widgetsPerScreen,
  maxBindingsPerWidget: DESIGN_LIMITS.bindingsPerWidget,
  maxWidgetJsonBytes: DESIGN_LIMITS.widgetJsonBytes,
  nameMaxChars: DESIGN_LIMITS.nameMaxChars,
  themes: SCREEN_THEMES,
  accents: SCREEN_ACCENTS,
  gridColumns: GRID_COLUMNS,
};

const unitOf = (rig: IdentityRig) => createUnitOfWork(rig.connection, (tx) => ({ registries: bindRegistryStore(tx), dashboard: bindDashboardStore(tx), catalog: bindCatalogReader(tx) }));
const clone = <T>(value: T): T => structuredClone(value);
const design = (...widgets: WidgetInput[]): DesignInput => ({ name: "Test MVP", theme: "dark", accent: "blue", widgets });
const table = (patch: Partial<WidgetInput> = {}): WidgetInput => ({ ...clone(F01_TABLE), ...patch });
const second = (): WidgetInput => table({ id: SECOND_TABLE, layout: { phone: { x: 0, y: 8, w: 1, h: 8 }, tablet: { x: 0, y: 8, w: 8, h: 8 }, desktop: { x: 0, y: 8, w: 8, h: 8 } } });

async function booksRig(): Promise<IdentityRig> {
  const rig = await createIdentityRig();
  const draft: RegistryDraft = { symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns };
  unitOf(rig).run((ports) => {
    const checked = validateNewRegistry(draft, { limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: new Set(), activeRegistryCount: 0 });
    if (!checked.ok) throw new Error("the registry of F01 was refused");
    ports.registries.insert({ id: BOOKS.id, ownerId: OWNER, columnIds: BOOKS.columns.map((column) => column.id), definition: checked.value, nowIso: NOW });
    ports.dashboard.create({ id: SCREEN, ownerId: OWNER, name: "Ekran", theme: "dark", accent: "blue", nowIso: NOW });
    return done(null);
  });
  return rig;
}

/** What the use case of D17.4 does for a save, in one unit: the rules on the real catalog, then the store. */
function save(rig: IdentityRig, input: DesignInput, options: { owner?: string; screen?: string; at?: string } = {}) {
  const owner = options.owner ?? OWNER;
  const screen = options.screen ?? SCREEN;
  return unitOf(rig).run((ports) => {
    const context: DesignContext = { ownerId: owner, screenId: screen, policy, widgets: createWidgetCatalog(), catalog: ports.catalog };
    const checked = validateDesign(input, context);
    const outcome: { ok: boolean; issues: readonly DesignIssue[] } = { ok: checked.ok, issues: checked.ok ? [] : checked.issues };
    if (checked.ok) ports.dashboard.replace(owner, screen, checked.value, options.at ?? LATER);
    return done(outcome);
  });
}
const accepted = (rig: IdentityRig, input: DesignInput, options?: Parameters<typeof save>[2]) => {
  const result = save(rig, input, options);
  if (!result.ok || !result.value.value.ok) throw new Error(`the design was not saved: ${JSON.stringify(result.ok ? result.value.value.issues : result)}`);
};
const read = (rig: IdentityRig, owner = OWNER, screen = SCREEN): StoredScreen | null => unitOf(rig).read((ports) => ports.dashboard.find(owner, screen));
const count = (rig: IdentityRig, table: "screen" | "widget" | "binding") => rig.rows(`SELECT 1 FROM ${table}`).length;
const addOwner = (rig: IdentityRig) => rig.sql(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('${OTHER}', 'o2', 'o2@example.test', 1, NULL, '${NOW}', '${NOW}')`);

describe("D17.3-AC1 the screen of F01 in the tables and back", () => {
  it("the register table of F01 is written and read back equal: its configuration, layouts and five bindings in order; and the same after a restart", async () => {
    const rig = await booksRig();
    accepted(rig, design(table()));
    const stored = read(rig)!;
    expect(stored).toMatchObject({ id: SCREEN, ownerId: OWNER, name: "Test MVP", theme: "dark", accent: "blue", createdAt: NOW, updatedAt: LATER });
    expect(stored.widgets).toEqual([{ ...F01_TABLE, config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true }, state: "ok" }]);
    expect(stored.widgets[0]!.bindings.map((binding) => binding.path)).toEqual(F01_TABLE.bindings.map((binding) => binding.path));
    expect([count(rig, "screen"), count(rig, "widget"), count(rig, "binding")]).toEqual([1, 1, 5]);
    rig.reopen();
    expect(read(rig)).toEqual(stored);
  });

  it("a replacement removes the widgets that are not in the design with their bindings, and keeps the others in their rows", async () => {
    const rig = await booksRig();
    accepted(rig, design(table(), second()));
    expect([count(rig, "widget"), count(rig, "binding")]).toEqual([2, 10]);
    const rowOfFirst = rig.rows<{ rowid: number }>(`SELECT rowid FROM widget WHERE id = '${F01_TABLE.id}'`)[0]!.rowid;

    // The second widget goes; the first loses a binding and changes its configuration.
    const trimmed = table({ config: { v: 1, title: "Zmieniony", pageSize: 25 }, bindings: F01_TABLE.bindings.filter((binding) => !binding.path.endsWith(".status")) });
    accepted(rig, design(trimmed));
    expect([count(rig, "widget"), count(rig, "binding")]).toEqual([1, 4]);
    expect(rig.rows<{ rowid: number }>(`SELECT rowid FROM widget WHERE id = '${F01_TABLE.id}'`)[0]!.rowid).toBe(rowOfFirst);
    expect(read(rig)!.widgets[0]).toMatchObject({ id: F01_TABLE.id, config: { title: "Zmieniony", pageSize: 25, allowAdd: true } });
    expect(rig.rows(`SELECT 1 FROM binding WHERE widget_id = '${SECOND_TABLE}'`)).toEqual([]);

    accepted(rig, design());
    expect([count(rig, "widget"), count(rig, "binding"), count(rig, "screen")]).toEqual([0, 0, 1]);
    // The same identifier can come back as a new widget.
    accepted(rig, design(table()));
    expect(read(rig)!.widgets.map((widget) => widget.id)).toEqual([F01_TABLE.id]);
  });

  it("two widgets swap places in one write, and the order of the snapshot is the order that is read", async () => {
    const rig = await booksRig();
    accepted(rig, design(table(), second()));
    expect(read(rig)!.widgets.map((widget) => widget.id)).toEqual([F01_TABLE.id, SECOND_TABLE]);
    accepted(rig, design(second(), table()));
    expect(read(rig)!.widgets.map((widget) => widget.id)).toEqual([SECOND_TABLE, F01_TABLE.id]);
    // The order of the bindings of a widget is kept too, though it is not the order of the slots.
    const shuffled = table({ bindings: [F01_TABLE.bindings[4]!, F01_TABLE.bindings[2]!, F01_TABLE.bindings[0]!, F01_TABLE.bindings[1]!, F01_TABLE.bindings[3]!] });
    accepted(rig, design(shuffled));
    expect(read(rig)!.widgets[0]!.bindings.map((binding) => `${binding.slot}.${binding.ordinal}`)).toEqual(["sortColumn.0", "columns.1", "registry.0", "columns.0", "columns.2"]);
  });

  it("the catalog reader gives a registry with all its columns, deleted ones too, and only to its owner; and the screen a widget is on", async () => {
    const rig = await booksRig();
    rig.sql(`UPDATE registry_column SET deleted_at = '${NOW}' WHERE symbol = 'autor'`);
    const view = unitOf(rig).read((ports) => ({
      own: ports.catalog.registry(OWNER, BOOKS.id),
      foreign: ports.catalog.registry(OTHER, BOOKS.id),
      none: ports.catalog.registry(OWNER, "019a0000-0000-7000-8000-0000000009ff"),
      before: ports.catalog.screenOfWidget(F01_TABLE.id),
    }));
    expect(view.own).toMatchObject({ id: BOOKS.id, symbol: "ksiazki", deleted: false });
    expect(view.own!.columns.map((column) => [column.symbol, column.deleted])).toEqual(BOOKS.columns.map((column) => [column.symbol, column.symbol === "autor"]));
    expect([view.foreign, view.none, view.before]).toEqual([null, null, null]);
    accepted(rig, design(table()));
    expect(unitOf(rig).read((ports) => ports.catalog.screenOfWidget(F01_TABLE.id))).toBe(SCREEN);
    rig.sql(`UPDATE registry SET deleted_at = '${NOW}'`);
    expect(unitOf(rig).read((ports) => ports.catalog.registry(OWNER, BOOKS.id))).toMatchObject({ deleted: true });
  });

  it("the state of a stored widget follows the catalog without a write; saving the broken widget again stores the state it has", async () => {
    const rig = await booksRig();
    accepted(rig, design(table()));
    const stateNow = (): string =>
      unitOf(rig).read((ports) => {
        const context: DesignContext = { ownerId: OWNER, screenId: SCREEN, policy, widgets: createWidgetCatalog(), catalog: ports.catalog };
        return stateOfStoredWidget(ports.dashboard.find(OWNER, SCREEN)!.widgets[0]!, context);
      });
    expect(stateNow()).toBe("ok");
    rig.sql(`UPDATE registry_column SET deleted_at = '${NOW}' WHERE symbol = 'tytul'`);
    expect(stateNow()).toBe("needs_rebinding");
    expect(read(rig)!.widgets[0]!.state).toBe("ok");
    // The screen can still be saved with the broken widget in it, which now keeps its state.
    accepted(rig, design(table()));
    expect(read(rig)!.widgets[0]!.state).toBe("needs_rebinding");
  });

  it("a widget found by its identifier, and only through the screen of its owner; screens are counted and found by owner", async () => {
    const rig = await booksRig();
    accepted(rig, design(table()));
    addOwner(rig);
    const view = unitOf(rig).read((ports) => ({
      mine: ports.dashboard.findWidget(OWNER, F01_TABLE.id),
      theirs: ports.dashboard.findWidget(OTHER, F01_TABLE.id),
      unknown: ports.dashboard.findWidget(OWNER, "019a0000-0000-7000-8000-0000000009ff"),
      counts: [ports.dashboard.count(OWNER), ports.dashboard.count(OTHER)],
      foreignScreen: ports.dashboard.find(OTHER, SCREEN),
    }));
    expect(view.mine).toMatchObject({ screenId: SCREEN, widget: { id: F01_TABLE.id, type: "register-table", state: "ok" } });
    expect([view.theirs, view.unknown, view.foreignScreen]).toEqual([null, null, null]);
    expect(view.counts).toEqual([1, 0]);
  });

  it("text of the user is a value only: SQL and markup in a title are stored and read back as they were", async () => {
    const rig = await booksRig();
    const title = `'); DROP TABLE widget; --<img src=x onerror=alert(1)> "quoted" \\ \u0000`;
    accepted(rig, design(table({ config: { v: 1, title } })), { at: LATER });
    expect(read(rig)!.widgets[0]!.config["title"]).toBe(title.trim());
    expect(count(rig, "widget")).toBe(1);
  });
});

describe("D17.3-AC2 what must not remain, and what is not taken over", () => {
  it("a failure in the middle of a replacement leaves the screen exactly as it was: its name, widgets, bindings and time", async () => {
    const rig = await booksRig();
    accepted(rig, design(table(), second()));
    const before = read(rig);
    const rowsBefore = JSON.stringify([rig.rows("SELECT * FROM widget ORDER BY id"), rig.rows("SELECT * FROM binding ORDER BY widget_id, slot, ordinal")]);

    rig.sql(`CREATE TRIGGER fail_binding BEFORE INSERT ON binding WHEN new.slot = 'sortColumn' AND new.widget_id = '${SECOND_TABLE}' BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END;`);
    const changed: DesignInput = { ...design(table({ config: { v: 1, title: "Nowy tytuł" } }), second(), table({ id: "019a0000-0000-7000-8000-0000000001a9" })), name: "Zmieniona nazwa", accent: "teal" };
    expect(() => save(rig, changed, { at: "2026-10-28T13:00:00.000Z" })).toThrow(/disk unavailable/);
    expect(read(rig)).toEqual(before);
    expect(JSON.stringify([rig.rows("SELECT * FROM widget ORDER BY id"), rig.rows("SELECT * FROM binding ORDER BY widget_id, slot, ordinal")])).toBe(rowsBefore);

    // The same replacement works once the fault is gone.
    rig.sql("DROP TRIGGER fail_binding");
    accepted(rig, changed, { at: "2026-10-28T13:00:00.000Z" });
    expect(read(rig)).toMatchObject({ name: "Zmieniona nazwa", accent: "teal", updatedAt: "2026-10-28T13:00:00.000Z" });
    expect(count(rig, "widget")).toBe(3);
  });

  it("the rules refuse a widget identifier that lives on another screen, and the store refuses it too when the rules are bypassed", async () => {
    const rig = await booksRig();
    addOwner(rig);
    unitOf(rig).run((ports) => done(ports.dashboard.create({ id: SCREEN_2, ownerId: OTHER, name: "Cudzy", theme: "dark", accent: "green", nowIso: NOW })));
    // The other owner's screen holds a widget of its own, on a registry of its own (none: a draft).
    const theirs: CheckedDesign = { name: "Cudzy", theme: "dark", accent: "green", widgets: [{ id: SECOND_TABLE, type: "register-table", config: { v: 1, title: "Tajny" }, layout: second().layout, bindings: [], state: "draft" }] };
    unitOf(rig).run((ports) => done(ports.dashboard.replace(OTHER, SCREEN_2, theirs, NOW)));
    accepted(rig, design(table()));
    const snapshot = JSON.stringify([rig.rows("SELECT * FROM widget ORDER BY id"), rig.rows("SELECT * FROM binding ORDER BY widget_id")]);

    // By the rules: refused with the path, and nothing written.
    const refused = save(rig, design(table(), second()));
    expect(refused.ok && refused.value.value.issues).toEqual([{ path: "widgets.1.id", code: "WIDGET_ID_TAKEN" }]);

    // By the store alone: the write fails and the other owner's widget is as it was.
    const stolen: CheckedDesign = { name: "Test MVP", theme: "dark", accent: "blue", widgets: [{ ...table(), state: "ok" }, { ...second(), config: { v: 1, title: "Przejęty" }, state: "draft" }] };
    expect(() => unitOf(rig).run((ports) => done(ports.dashboard.replace(OWNER, SCREEN, stolen, LATER)))).toThrow(/another screen/);
    expect(JSON.stringify([rig.rows("SELECT * FROM widget ORDER BY id"), rig.rows("SELECT * FROM binding ORDER BY widget_id")])).toBe(snapshot);
    expect(rig.rows<{ screen_id: string; config: string }>(`SELECT screen_id, config FROM widget WHERE id = '${SECOND_TABLE}'`)).toEqual([{ screen_id: SCREEN_2, config: JSON.stringify({ v: 1, title: "Tajny" }) }]);
  });

  it("a screen of another owner is neither found nor replaced, and a replacement for it changes nothing", async () => {
    const rig = await booksRig();
    addOwner(rig);
    accepted(rig, design(table()));
    const before = JSON.stringify([rig.rows("SELECT * FROM screen"), rig.rows("SELECT * FROM widget"), rig.rows("SELECT * FROM binding")]);
    expect(read(rig, OTHER)).toBeNull();
    const checked: CheckedDesign = { name: "Przejęty", theme: "dark", accent: "pink", widgets: [] };
    expect(() => unitOf(rig).run((ports) => done(ports.dashboard.replace(OTHER, SCREEN, checked, LATER)))).toThrow(/not the owner's/);
    expect(() => unitOf(rig).run((ports) => done(ports.dashboard.replace(OWNER, "019a0000-0000-7000-8000-0000000009ff", checked, LATER)))).toThrow(/not the owner's/);
    expect(JSON.stringify([rig.rows("SELECT * FROM screen"), rig.rows("SELECT * FROM widget"), rig.rows("SELECT * FROM binding")])).toBe(before);
    // The rules see a registry of the owner only: a design for the owner's screen cannot point at someone else's registry.
    const result = save(rig, design(table()), { owner: OTHER });
    expect(result.ok).toBe(true);
  });

  it("the tables refuse by themselves what is not a screen, a widget or a binding", async () => {
    const rig = await booksRig();
    accepted(rig, design(table()));
    const run = (sql: string, ...values: unknown[]) => () => rig.connection.handle.prepare(sql).run(...values);
    const screen = (patch: Record<string, unknown>) => {
      const v = { id: "019a0000-0000-7000-8000-0000000003a0", user_id: OWNER, name: "N", theme: "dark", accent: "blue", ...patch };
      return run("INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", v.id, v.user_id, v.name, v.theme, v.accent, NOW, NOW);
    };
    for (const patch of [{ theme: "light" }, { accent: "red" }, { name: "" }, { name: "x".repeat(81) }]) expect(screen(patch), JSON.stringify(patch)).toThrow(/CHECK/);
    expect(screen({ user_id: "nobody" })).toThrow(/FOREIGN KEY/);
    expect(screen({ id: SCREEN })).toThrow(/UNIQUE|PRIMARY/);

    const layout = JSON.stringify(F01_TABLE.layout);
    const widget = (patch: Record<string, unknown>) => {
      const v = { id: "019a0000-0000-7000-8000-0000000003b0", screen_id: SCREEN, position: 9, type: "register-table", config: "{}", layout, state: "ok", ...patch };
      return run("INSERT INTO widget (id, screen_id, position, type, config, layout, state) VALUES (?, ?, ?, ?, ?, ?, ?)", v.id, v.screen_id, v.position, v.type, v.config, v.layout, v.state);
    };
    for (const patch of [{ config: "[]" }, { config: "not json" }, { config: `{"x":"${"y".repeat(33_000)}"}` }, { layout: "{}" }, { layout: '{"phone":{},"tablet":{}}' }, { layout: "[]" }, { state: "broken" }, { position: -1 }, { type: "" }, { type: "x".repeat(65) }]) {
      expect(widget(patch), JSON.stringify(patch).slice(0, 40)).toThrow(/CHECK/);
    }
    expect(widget({ screen_id: "no-such-screen" })).toThrow(/FOREIGN KEY/);
    expect(widget({ id: F01_TABLE.id })).toThrow(/UNIQUE|PRIMARY/);

    const binding = (patch: Record<string, unknown>) => {
      const v = { widget_id: F01_TABLE.id, slot: "extra", ordinal: 0, position: 9, path: "Field.Register.ksiazki", target: '{"kind":"registry","registryId":"x"}', ...patch };
      return run("INSERT INTO binding (widget_id, slot, ordinal, position, path, target) VALUES (?, ?, ?, ?, ?, ?)", v.widget_id, v.slot, v.ordinal, v.position, v.path, v.target);
    };
    for (const patch of [{ ordinal: 64 }, { ordinal: -1 }, { position: -1 }, { slot: "" }, { path: "" }, { path: "x".repeat(301) }, { target: "[]" }, { target: "{}" }, { target: '{"kind":5}' }, { target: "not json" }, { target: `{"kind":"x","pad":"${"y".repeat(1100)}"}` }]) {
      expect(binding(patch), JSON.stringify(patch).slice(0, 40)).toThrow(/CHECK/);
    }
    expect(binding({ widget_id: "no-such-widget" })).toThrow(/FOREIGN KEY/);
    expect(binding({ slot: "columns", ordinal: 0 })).toThrow(/UNIQUE|PRIMARY/);
    // A binding is not tied to the registry it names: a broken one must stay a row.
    binding({ target: '{"kind":"column","registryId":"gone","columnId":"gone"}' })();
    expect(rig.rows(`SELECT 1 FROM binding WHERE widget_id = '${F01_TABLE.id}'`)).toHaveLength(6);
  });

  it("deleting a widget takes its bindings with it, and the index by registry finds the bindings of a registry", async () => {
    const rig = await booksRig();
    accepted(rig, design(table(), second()));
    expect(rig.rows(`SELECT widget_id FROM binding WHERE json_extract(target, '$.registryId') = '${BOOKS.id}' GROUP BY widget_id ORDER BY widget_id`)).toHaveLength(2);
    expect(rig.rows<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT widget_id FROM binding WHERE json_extract(target, '$.registryId') = 'x'`).some((row) => /binding_by_registry/.test(row.detail))).toBe(true);
    rig.sql(`DELETE FROM widget WHERE id = '${SECOND_TABLE}'`);
    expect(count(rig, "binding")).toBe(5);
  });

  it("a database of the version before upgrades with its data intact, and then holds a screen", async () => {
    const file = path.join(scratchDir("openlife-dashboard-migration-"), "app.db");
    const connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
    try {
      initializeDatabase(connection, PRODUCT_MIGRATION_PLAN.slice(0, 11), { instanceId: "4f7d2c9e-8a31-4b6e-9d0f-2c5a7e1b3d4a", createdAt: NOW });
      connection.handle.prepare(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('owner-1', 'o', 'o@example.test', 1, NULL, ?, ?)`).run(NOW, NOW);
      expect(migrateDatabase(connection, PRODUCT_MIGRATION_PLAN, NOW)).toEqual({ fromSchemaVersion: 11, toSchemaVersion: PRODUCT_MIGRATION_PLAN.length });
      expect(connection.handle.prepare(`SELECT email FROM "user"`).pluck().get()).toBe("o@example.test");
      expect(connection.handle.prepare("SELECT count(*) FROM screen").pluck().get()).toBe(0);
      expect(connection.handle.prepare("SELECT id FROM schema_migration WHERE version = 12").pluck().get()).toBe("0012-dashboard");
    } finally {
      connection.close();
    }
  });
});
