// D17.4 — the screen, its design and the data of its widget over real HTTP (Architektura §5.4, §6,
// §18.3, §18.5). The first block runs the built server process with an owner made by the CLI; the
// second composes the same application in the test process (tests/support/app-harness.ts), where the
// database can be changed behind the application, a write can fail, and a request can be stopped
// between its middleware and its unit of work.
// AC1: F01 through the API: the first screen, the register table with two columns and the sort by
//      creation saved and read back canonical, and its data are the 25 records as pages of 10, 10
//      and 5, the same after a restart; the catalog of types has the manifest.
// AC2: an unknown type, a foreign or unknown target, a path that disagrees, two registries, a state
//      or an owner sent by the client, a taken widget id, an unknown screen, every state before the
//      gate, a foreign Origin, an ended session and a failing write or audit are refused without a
//      change of the screen; the data of a widget comes only from its saved bindings, and a widget
//      that is not ok reads nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, registryListSchema, type RegistryDto } from "@openlife/contracts/http/registries";
import { SCREENS_PATH, screenDesignPath, screenListSchema, screenPath, screenSchema, widgetDataPath, widgetDataSchema, widgetTypesSchema, type ScreenDto } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses } from "../../support/app-harness.ts";
import { ack, chooseEmpty, enrolled, installation, post, query, readyOwner, send, serve, signIn, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";
import { createSignedInHarness } from "../../support/signed-in-harness.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ values: Record<string, unknown> }> }> };
const expected = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { pageTitles: string[][] };
const BOOKS = fixture.registries[0]!;
const booksRequest = () => ({
  symbol: BOOKS.symbol,
  displayName: BOOKS.displayName,
  columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions, defaultValue, required })),
});
const WAGA = { symbol: "waga", displayName: "Waga", columns: [{ symbol: "kg", displayName: "Kg", type: "number", typeOptions: { decimalPlaces: 1 } }] };
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WIDGET = "019a0000-0000-7000-8000-00000000019a";
const WIDGET_2 = "019a0000-0000-7000-8000-00000000019d";
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const details = (reply: { json: () => unknown }): unknown => apiErrorSchema.parse(reply.json()).details;
const issuesOf = (reply: { json: () => unknown }): string[] => ((details(reply) as { issues: Array<{ path: string; code: string }> }).issues).map((issue) => `${issue.path}:${issue.code}`);

const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 8, h: 8 } };

/** The register table of F01 with the minimal bindings of the plan (two columns and the sort by creation) for a registry as the server holds it. */
function tableOf(registry: RegistryDto, patch: { id?: string; config?: Record<string, unknown>; columns?: string[]; bindings?: unknown[] } = {}) {
  const column = (symbol: string) => registry.columns.find((candidate) => candidate.symbol === symbol)!;
  const columns = (patch.columns ?? ["tytul", "autor"]).map((symbol, ordinal) => ({ slot: "columns", ordinal, path: `Field.Register.${registry.symbol}.${symbol}`, target: { kind: "column", registryId: registry.id, columnId: column(symbol).id } }));
  return {
    id: patch.id ?? WIDGET,
    type: "register-table",
    config: patch.config ?? { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true },
    layout: LAYOUT,
    bindings: patch.bindings ?? [
      { slot: "registry", ordinal: 0, path: `Field.Register.${registry.symbol}`, target: { kind: "registry", registryId: registry.id } },
      ...columns,
      { slot: "sortColumn", ordinal: 0, path: `Field.Register.${registry.symbol}.created_at`, target: { kind: "systemColumn", registryId: registry.id, symbol: "created_at" } },
    ],
  };
}
const designOf = (...widgets: unknown[]) => ({ name: "Test MVP", theme: "dark", accent: "blue", widgets });
const keyOf = (n: number): string => `seed-key-${String(n).padStart(6, "0")}`;

describe("D17.4-AC1 F01 through the real API", () => {
  async function owned(setup: Installation) {
    const owner = await readyOwner(setup);
    const cookie = owner.sessionCookie;
    expect((await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie })).status).toBe(201);
    const registry = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries[0]!;
    return { cookie, registry };
  }

  it("the first screen, the register table saved and read back, its data as the 25 records of F01 in pages of 10, 10 and 5, and the same after a restart", async () => {
    const setup = await installation();
    const { server } = setup;
    const { cookie, registry } = await owned(setup);
    for (const [index, record] of BOOKS.records.entries()) {
      const added = await post(server, registryRecordsPath("ksiazki"), { schemaRevision: 1, values: record.values }, { cookie, headers: { "Idempotency-Key": keyOf(index) } });
      if (added.status !== 201) throw new Error(`record ${index} was ${added.status}`);
    }

    const created = await post(server, SCREENS_PATH, { name: "  Test MVP  " }, { cookie });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const screen = screenSchema.parse(created.json());
    expect(screen).toMatchObject({ name: "Test MVP", theme: "dark", accent: "blue", widgets: [] });
    expect(screen.id).toMatch(V7);
    expect(created.text).not.toMatch(/user_id|ownerId/i);
    expect(screenListSchema.parse((await send(server, "GET", SCREENS_PATH, undefined, { cookie })).json()).screens).toEqual([{ id: screen.id, name: "Test MVP", createdAt: screen.createdAt }]);

    const saved = await send(server, "PUT", screenDesignPath(screen.id), designOf(tableOf(registry)), { cookie });
    expect(saved.status).toBe(200);
    const canonical = screenSchema.parse(saved.json());
    expect(canonical.widgets).toHaveLength(1);
    expect(canonical.widgets[0]).toMatchObject({ id: WIDGET, type: "register-table", state: "ok", config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true }, layout: LAYOUT });
    expect(canonical.widgets[0]!.bindings.map((binding) => binding.path)).toEqual(["Field.Register.ksiazki", "Field.Register.ksiazki.tytul", "Field.Register.ksiazki.autor", "Field.Register.ksiazki.created_at"]);
    // The answer to a read is the answer to the save.
    expect(screenSchema.parse((await send(server, "GET", screenPath(screen.id), undefined, { cookie })).json())).toEqual(canonical);

    const pageOf = async (target: Installation["server"], page: number) => widgetDataSchema.parse((await send(target, "GET", `${widgetDataPath(WIDGET)}?page=${page}`, undefined, { cookie })).json());
    const check = async (target: Installation["server"]) => {
      const pages = [await pageOf(target, 1), await pageOf(target, 2), await pageOf(target, 3), await pageOf(target, 4)];
      expect(pages.map((page) => page.rows.length)).toEqual([10, 10, 5, 0]);
      expect(pages.map((page) => page.total)).toEqual([25, 25, 25, 25]);
      expect(pages.slice(0, 3).map((page) => page.rows.map((row) => row.values["tytul"]))).toEqual(expected.pageTitles);
      expect(pages[0]).toMatchObject({ widgetId: WIDGET, state: "ok", page: 1, pageSize: 10, registry: { symbol: "ksiazki", schemaRevision: 1, dataRevision: 25 } });
      return pages;
    };
    const pages = await check(server);
    // Only what is bound is returned: two columns, no price, no creation time, no owner.
    expect(pages[0]!.columns.map((each) => [each.key, each.kind, each.type, each.displayName])).toEqual([["tytul", "column", "text", "Tytuł"], ["autor", "column", "text", "Autor"]]);
    expect(pages[0]!.rows.every((row) => Object.keys(row.values).join() === "tytul,autor")).toBe(true);
    expect(JSON.stringify(pages)).not.toMatch(/user_id|ownerId|cena|reg_ksiazki/i);

    await stopServer(server);
    const again = await serve(setup.instance);
    expect(await check(again)).toEqual(pages);
    expect(screenSchema.parse((await send(again, "GET", screenPath(screen.id), undefined, { cookie })).json())).toEqual(canonical);
  });

  it("the catalog of types has the register table with its slots, capability and sizes", async () => {
    const setup = await installation();
    const { cookie } = await owned(setup);
    const reply = await send(setup.server, "GET", "/api/v1/widget-types", undefined, { cookie });
    expect(widgetTypesSchema.parse(reply.json()).types).toEqual([
      {
        type: "register-table",
        configVersion: 1,
        capabilities: ["records:add"],
        defaultSize: { w: 8, h: 8 },
        minSize: { w: 3, h: 4 },
        slots: [
          { name: "registry", cardinality: "one", required: true, accepts: ["registry"] },
          { name: "columns", cardinality: "many", required: true, accepts: ["column", "systemColumn"] },
          { name: "sortColumn", cardinality: "one", required: false, accepts: ["column", "systemColumn"] },
        ],
      },
    ]);
  });

  it("a table sorted by a column of its registry and in the other direction reads in that order, and a bare configuration gets its defaults", async () => {
    const setup = await installation();
    const { cookie, registry } = await owned(setup);
    for (const [index, title] of ["B", "C", "A"].entries()) {
      expect((await post(setup.server, registryRecordsPath("ksiazki"), { schemaRevision: 1, values: { tytul: title } }, { cookie, headers: { "Idempotency-Key": keyOf(index) } })).status).toBe(201);
    }
    const screen = screenSchema.parse((await post(setup.server, SCREENS_PATH, { name: "Ekran" }, { cookie })).json());
    const sortByTitle = [
      { slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: registry.id } },
      { slot: "columns", ordinal: 0, path: "Field.Register.ksiazki.tytul", target: { kind: "column", registryId: registry.id, columnId: registry.columns.find((c) => c.symbol === "tytul")!.id } },
      { slot: "sortColumn", ordinal: 0, path: "Field.Register.ksiazki.tytul", target: { kind: "column", registryId: registry.id, columnId: registry.columns.find((c) => c.symbol === "tytul")!.id } },
    ];
    const saved = await send(setup.server, "PUT", screenDesignPath(screen.id), designOf(tableOf(registry, { config: { v: 1, sortDirection: "asc" }, bindings: sortByTitle })), { cookie });
    expect(screenSchema.parse(saved.json()).widgets[0]!.config).toEqual({ v: 1, title: "", pageSize: 10, sortDirection: "asc", allowAdd: true });
    const data = widgetDataSchema.parse((await send(setup.server, "GET", widgetDataPath(WIDGET), undefined, { cookie })).json());
    expect(data.rows.map((row) => row.values["tytul"])).toEqual(["A", "B", "C"]);
  });
});

describe("D17.4-AC2 every state before the gate, and the Origin", () => {
  it("each state is refused with its code on the six routes, and nothing is made", async () => {
    const setup = await installation();
    const { server } = setup;
    const routes: Array<[string, string, unknown]> = [
      ["GET", SCREENS_PATH, undefined],
      ["POST", SCREENS_PATH, { name: "Ekran" }],
      ["GET", screenPath(WIDGET), undefined],
      ["PUT", screenDesignPath(WIDGET), designOf()],
      ["GET", "/api/v1/widget-types", undefined],
      ["GET", widgetDataPath(WIDGET), undefined],
    ];
    const refusal = async (cookie: string | null, expectedReply: [number, string]) => {
      for (const [method, route, body] of routes) {
        const reply = await send(server, method, route, body, { cookie });
        expect([method, route, reply.status, code(reply)]).toEqual([method, route, ...expectedReply]);
      }
    };
    await refusal(null, [401, "AUTH_REQUIRED"]);
    await refusal("openlife-000000000000.session_token=forged.value", [401, "AUTH_REQUIRED"]);
    const password = (await signIn(server)).cookie ?? "";
    await refusal(password, [403, "MFA_REQUIRED"]);
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    await refusal(session, [403, "RECOVERY_ACK_REQUIRED"]);
    expect((await ack(server, session, first.codes?.batchId ?? "")).status).toBe(200);
    await refusal(session, [403, "SETUP_DATA_REQUIRED"]);
    expect(query(setup.instance, "SELECT 1 FROM screen")).toEqual([]);
    expect((await chooseEmpty(server, session)).status).toBe(200);
    expect((await post(server, SCREENS_PATH, { name: "Ekran" }, { cookie: session })).status).toBe(201);
  });

  it("a foreign, missing or null Origin cannot make a screen or save a design", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    for (const origin of ["https://evil.example", null, "null", "http://localhost:8080.evil.example", "http://localhost:8081"]) {
      const made = await send(setup.server, "POST", SCREENS_PATH, { name: "Ekran" }, { cookie: owner.sessionCookie, origin });
      const saved = await send(setup.server, "PUT", screenDesignPath(WIDGET), designOf(), { cookie: owner.sessionCookie, origin });
      expect([origin, made.status, code(made), saved.status, code(saved)]).toEqual([origin, 403, "ORIGIN_FORBIDDEN", 403, "ORIGIN_FORBIDDEN"]);
    }
    expect(query(setup.instance, "SELECT 1 FROM screen")).toEqual([]);
  });
});

describe("D17.4-AC2 in the test process: what is refused, and what is left behind", () => {
  async function ready() {
    const { h, cookie } = await createSignedInHarness();
    expect((await h.request("POST", REGISTRIES_PATH, booksRequest(), { cookie })).status).toBe(201);
    expect((await h.request("POST", REGISTRIES_PATH, WAGA, { cookie })).status).toBe(201);
    const registries = registryListSchema.parse((await h.request("GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries;
    const books = registries.find((registry) => registry.symbol === "ksiazki")!;
    const waga = registries.find((registry) => registry.symbol === "waga")!;
    const screen = screenSchema.parse((await h.request("POST", SCREENS_PATH, { name: "Ekran" }, { cookie })).json());
    const put = (body: unknown, id = screen.id) => h.request("PUT", screenDesignPath(id), body, { cookie });
    const get = async (): Promise<ScreenDto> => screenSchema.parse((await h.request("GET", screenPath(screen.id), undefined, { cookie })).json());
    const data = (id = WIDGET, extra = "") => h.request("GET", `${widgetDataPath(id)}${extra}`, undefined, { cookie });
    const audit = (action: string) => h.rows<{ details: string | null }>(`SELECT details FROM audit_log WHERE action = '${action}'`);
    return { h, cookie, books, waga, screen, put, get, data, audit };
  }
  type Rig = Awaited<ReturnType<typeof ready>>;
  const seed = async (rig: Rig, count: number) => {
    for (let index = 0; index < count; index += 1) {
      const added = await rig.h.request("POST", registryRecordsPath("ksiazki"), { schemaRevision: 1, values: { tytul: `Książka ${index + 1}`, cena: 1000 + index } }, { cookie: rig.cookie, headers: { "Idempotency-Key": keyOf(index) } });
      if (added.status !== 201) throw new Error(`record ${index} was ${added.status}`);
    }
  };

  it("one screen for the owner: a second is 409 SCREEN_LIMIT_EXCEEDED; a bad name or a field of the server is 422; an unknown screen is 404", async () => {
    const { h, cookie, screen, get, put } = await ready();
    const second = await h.request("POST", SCREENS_PATH, { name: "Drugi" }, { cookie });
    expect([second.status, code(second)]).toEqual([409, "SCREEN_LIMIT_EXCEEDED"]);
    expect(h.rows("SELECT 1 FROM screen")).toHaveLength(1);
    for (const name of ["", "   ", "x".repeat(81), "line\nbreak"]) {
      const reply = await h.request("POST", SCREENS_PATH, { name }, { cookie });
      expect([JSON.stringify(name), reply.status]).toEqual([JSON.stringify(name), 422]);
    }
    for (const extra of [{ ownerId: "x" }, { theme: "dark" }, { accent: "red" }, { id: WIDGET }]) {
      expect((await h.request("POST", SCREENS_PATH, { name: "Ekran", ...extra }, { cookie })).status, JSON.stringify(extra)).toBe(422);
    }
    for (const id of ["019a0000-0000-7000-8000-0000000009ff", "nope", "..", "%00"]) {
      const read = await h.request("GET", screenPath(id), undefined, { cookie });
      const write = await put(designOf(), id);
      expect([id, read.status, code(read), write.status, code(write)]).toEqual([id, 404, "NOT_FOUND", 404, "NOT_FOUND"]);
    }
    expect((await get()).id).toBe(screen.id);
    expect(h.rows<{ details: string | null }>("SELECT details FROM audit_log WHERE action = 'screen.created'")).toHaveLength(1);
  });

  it("a design the rules refuse is 422 with every issue at its path, and the screen is as it was", async () => {
    const { books, waga, put, get, audit } = await ready();
    expect((await put(designOf(tableOf(books)))).status).toBe(200);
    const before = await get();
    const auditBefore = audit("screen.design_saved").length;

    const wagaColumn = waga.columns[0]!;
    const attempts: Array<[string, unknown, string[]]> = [
      ["an unknown type", designOf({ ...tableOf(books), type: "clock" }), ["widgets.0.type:WIDGET_TYPE_UNKNOWN"]],
      ["a registry of nobody", designOf(tableOf(books, { bindings: [{ slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: "019a0000-0000-7000-8000-0000000009ff" } }] })), ["widgets.0.bindings.0.target:TARGET_UNKNOWN"]],
      ["a column of another registry under the target of this one", designOf(tableOf(books, { bindings: [{ slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: books.id } }, { slot: "columns", ordinal: 0, path: "Field.Register.ksiazki.kg", target: { kind: "column", registryId: books.id, columnId: wagaColumn.id } }] })), ["widgets.0.bindings.1.target:TARGET_UNKNOWN"]],
      ["two registries in one widget", designOf(tableOf(books, { bindings: [{ slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: books.id } }, { slot: "columns", ordinal: 0, path: "Field.Register.waga.kg", target: { kind: "column", registryId: waga.id, columnId: wagaColumn.id } }] })), ["widgets.0.bindings:REGISTRY_MISMATCH"]],
      ["a path that disagrees with the identity", designOf(tableOf(books, { bindings: [{ slot: "registry", ordinal: 0, path: "Field.Register.waga", target: { kind: "registry", registryId: books.id } }] })), ["widgets.0.bindings.0.path:PATH_MISMATCH"]],
      ["a configuration out of range", designOf(tableOf(books, { config: { v: 1, pageSize: 101 } })), ["widgets.0.config:CONFIG_INVALID"]],
      ["a layout off the grid", designOf({ ...tableOf(books), layout: { ...LAYOUT, desktop: { x: 9, y: 0, w: 8, h: 8 } } }), ["widgets.0.layout.desktop:LAYOUT_OUT_OF_GRID"]],
      ["a repeated widget id", designOf(tableOf(books), tableOf(books)), ["widgets.1.id:WIDGET_ID_DUPLICATE"]],
      ["a theme and an accent that do not exist", { ...designOf(tableOf(books)), theme: "light", accent: "red" }, []],
    ];
    for (const [name, body, issues] of attempts) {
      const reply = await put(body);
      expect([name, reply.status], name).toEqual([name, 422]);
      if (issues.length > 0) expect(issuesOf(reply), name).toEqual(issues);
      expect(await get(), name).toEqual(before);
    }
    expect(audit("screen.design_saved")).toHaveLength(auditBefore);
  });

  it("a state, an owner or an id sent by the client is refused by the contract; so is a body over the limit", async () => {
    const { books, put, get } = await ready();
    const before = await get();
    const base = tableOf(books);
    const sent: unknown[] = [
      designOf({ ...base, state: "ok" }),
      designOf({ ...base, ownerId: "someone-else" }),
      { ...designOf(base), id: WIDGET },
      { ...designOf(base), ownerId: "x" },
      designOf({ ...base, layout: { ...LAYOUT, large: { x: 0, y: 0, w: 4, h: 4 } } }),
      designOf({ ...base, bindings: [{ ...base.bindings[0]!, state: "ok" }] }),
      designOf({ ...base, bindings: [{ ...base.bindings[0]!, target: { kind: "registry", registryId: books.id, tableName: "user" } }] }),
      { name: "Ekran" },
      [],
      "text",
    ];
    for (const body of sent) {
      const reply = await put(body);
      expect([JSON.stringify(body).slice(0, 60), reply.status, code(reply)]).toEqual([JSON.stringify(body).slice(0, 60), 422, "VALIDATION_FAILED"]);
    }
    const huge = await put(designOf({ ...base, config: { v: 1, title: "x".repeat(300 * 1024) } }));
    expect([huge.status, code(huge)]).toEqual([422, "VALIDATION_FAILED"]);
    expect(await get()).toEqual(before);
  });

  it("a widget id that lives on another screen is refused with its path, and that screen is not touched", async () => {
    const { h, books, put, get, data } = await ready();
    h.sql(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('owner-2', 'o2', 'o2@example.test', 1, NULL, '2026-10-28T12:00:00.000Z', '2026-10-28T12:00:00.000Z')`);
    h.sql(`INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES ('019a0000-0000-7000-8000-0000000002a0', 'owner-2', 'Cudzy', 'dark', 'green', '2026-10-28T12:00:00.000Z', '2026-10-28T12:00:00.000Z')`);
    h.sql(`INSERT INTO widget (id, screen_id, position, type, config, layout, state) VALUES ('${WIDGET_2}', '019a0000-0000-7000-8000-0000000002a0', 0, 'register-table', '{"v":1,"title":"Cudzy"}', '${JSON.stringify(LAYOUT)}', 'draft')`);
    const before = await get();
    const reply = await put(designOf(tableOf(books), tableOf(books, { id: WIDGET_2 })));
    expect([reply.status, issuesOf(reply)]).toEqual([422, ["widgets.1.id:WIDGET_ID_TAKEN"]]);
    expect(await get()).toEqual(before);
    expect(h.rows(`SELECT config FROM widget WHERE id = '${WIDGET_2}'`)).toEqual([{ config: '{"v":1,"title":"Cudzy"}' }]);
    // And that widget is not readable through this owner.
    expect((await data(WIDGET_2)).status).toBe(404);
  });

  it("a widget that is not ok reads nothing: a draft, a broken binding and a configuration of the future get their state and no rows, and no query is made", async () => {
    const rig = await ready();
    const { h, books, put, get, data } = rig;
    await seed(rig, 3);
    expect((await put(designOf(tableOf(books), tableOf(books, { id: WIDGET_2, bindings: [] })))).status).toBe(200);
    const ok = widgetDataSchema.parse((await data()).json());
    expect([ok.state, ok.total]).toEqual(["ok", 3]);

    // The table of the registry is taken away: any query to it would fail, so a 200 means none was made.
    h.sql("ALTER TABLE reg_ksiazki RENAME TO reg_moved");
    const draft = widgetDataSchema.parse((await data(WIDGET_2)).json());
    expect(draft).toMatchObject({ state: "draft", registry: null, columns: [], rows: [], total: 0, page: 1 });
    h.sql("ALTER TABLE reg_moved RENAME TO reg_ksiazki");

    // A column deleted since: the screen is still saved and read, and the widget is needs_rebinding.
    h.sql("UPDATE registry_column SET deleted_at = '2026-10-28T12:00:00.000Z' WHERE symbol = 'autor'");
    h.sql("ALTER TABLE reg_ksiazki RENAME TO reg_moved");
    const broken = widgetDataSchema.parse((await data()).json());
    expect(broken).toMatchObject({ state: "needs_rebinding", registry: null, rows: [], total: 0 });
    h.sql("ALTER TABLE reg_moved RENAME TO reg_ksiazki");
    expect((await get()).widgets.map((widget) => [widget.id, widget.state])).toEqual([[WIDGET, "needs_rebinding"], [WIDGET_2, "draft"]]);
    expect((await put(designOf(tableOf(books)))).status).toBe(200);
    expect((await get()).widgets.map((widget) => widget.state)).toEqual(["needs_rebinding"]);

    // A registry deleted since, and a configuration of a version this build does not write.
    h.sql("UPDATE registry SET deleted_at = '2026-10-28T12:00:00.000Z'");
    expect(widgetDataSchema.parse((await data()).json()).state).toBe("needs_rebinding");
    h.sql("UPDATE registry SET deleted_at = NULL");
    h.sql("UPDATE registry_column SET deleted_at = NULL");
    expect((await put(designOf(tableOf(books, { config: { v: 2, title: "z przyszłości" } })))).status).toBe(200);
    expect((await get()).widgets[0]).toMatchObject({ state: "needs_refresh", config: { v: 2, title: "z przyszłości" } });
    h.sql("ALTER TABLE reg_ksiazki RENAME TO reg_moved");
    expect(widgetDataSchema.parse((await data()).json())).toMatchObject({ state: "needs_refresh", rows: [], total: 0 });
    h.sql("ALTER TABLE reg_moved RENAME TO reg_ksiazki");
  });

  it("the client names only the widget and the page: a registry, columns, sort, size or SQL in the query change nothing; a bad page is 422; an unknown widget is 404", async () => {
    const rig = await ready();
    const { h, books, put, data } = rig;
    await seed(rig, 12);
    expect((await put(designOf(tableOf(books)))).status).toBe(200);
    const plain = await data();
    expect(widgetDataSchema.parse(plain.json())).toMatchObject({ total: 12, pageSize: 10 });
    const hostile = ["registry=waga", "columns=cena", "sort=cena", "direction=asc", "pageSize=100", "table=user", "sql=SELECT%20*%20FROM%20user", "ownerId=owner-2", "registryId=x&columnId=y"];
    for (const extra of hostile) {
      const reply = await data(WIDGET, `?${extra}`);
      expect([extra, reply.status, reply.text]).toEqual([extra, 200, plain.text]);
    }
    expect(widgetDataSchema.parse((await data(WIDGET, "?page=2&registry=waga")).json())).toMatchObject({ page: 2, pageSize: 10 });
    expect(widgetDataSchema.parse((await data(WIDGET, "?page=2")).json()).rows).toHaveLength(2);
    for (const page of ["0", "-1", "1.5", "abc", "1e3", "", "99999999999", " 1", "1;2"]) {
      const reply = await data(WIDGET, `?page=${encodeURIComponent(page)}`);
      expect([page, reply.status]).toEqual([page, 422]);
    }
    for (const id of ["019a0000-0000-7000-8000-0000000009ff", "nope", "..", books.id]) {
      const reply = await data(id);
      expect([id, reply.status, code(reply)]).toEqual([id, 404, "NOT_FOUND"]);
    }
    expect(h.rows("SELECT 1 FROM screen")).toHaveLength(1);
  });

  it("a widget removed from the design is gone with its bindings and no longer readable; saving the same design twice changes nothing", async () => {
    const rig = await ready();
    const { h, books, put, get, data } = rig;
    expect((await put(designOf(tableOf(books)))).status).toBe(200);
    const first = await get();
    expect((await put(designOf(tableOf(books)))).status).toBe(200);
    expect({ ...(await get()), updatedAt: "" }).toEqual({ ...first, updatedAt: "" });
    expect((await put(designOf())).status).toBe(200);
    expect((await get()).widgets).toEqual([]);
    expect(h.rows("SELECT 1 FROM widget")).toEqual([]);
    expect(h.rows("SELECT 1 FROM binding")).toEqual([]);
    expect((await data()).status).toBe(404);
  });

  it("a session that ends between the middleware and the unit changes nothing: 401, the screen as it was", async () => {
    const { h, books, put, get } = await ready();
    const before = await get();
    h.interruptNextWrite(() => h.sql(`DELETE FROM "session"`));
    const reply = await put(designOf(tableOf(books)));
    expect([reply.status, code(reply)]).toEqual([401, "AUTH_REQUIRED"]);
    expect(h.rows("SELECT 1 FROM widget")).toEqual([]);
    expect(before.widgets).toEqual([]);
  });

  it("a failing write gives 503 with the screen as it was, a failing audit too, and the same request works once they do", async () => {
    const { h, cookie, books, put, get, audit } = await ready();
    expect((await put(designOf(tableOf(books)))).status).toBe(200);
    const before = await get();
    const next = designOf(tableOf(books, { config: { v: 1, title: "Nowy tytuł secret-detail" } }), tableOf(books, { id: WIDGET_2 }));

    h.sql(`CREATE TRIGGER fail_binding BEFORE INSERT ON binding WHEN new.widget_id = '${WIDGET_2}' BEGIN SELECT RAISE(ABORT, 'disk unavailable: secret-detail'); END;`);
    const failed = await put(next);
    expect([failed.status, code(failed)]).toEqual([503, "AUTH_UNAVAILABLE"]);
    expect(failed.text).not.toContain("secret-detail");
    expect(h.logLines().join("\n")).not.toContain("secret-detail");
    expect(await get()).toEqual(before);
    h.sql("DROP TRIGGER fail_binding");

    h.sql(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN new.action = 'screen.design_saved' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect((await put(next)).status).toBe(503);
    expect(await get()).toEqual(before);
    h.sql("DROP TRIGGER fail_audit");

    const worked = await put(next);
    expect(worked.status).toBe(200);
    expect((await get()).widgets).toHaveLength(2);
    expect(cookie.length).toBeGreaterThan(0);
    expect(audit("screen.design_saved")).toHaveLength(2);
  });

  it("the audit names the screen and the number of widgets, not the design; the log holds no title", async () => {
    const { h, books, put, audit } = await ready();
    await put(designOf(tableOf(books, { config: { v: 1, title: "Tytuł-tajny-ekranu" } })));
    const entries = audit("screen.design_saved");
    expect(entries.map((entry) => JSON.parse(entry.details ?? "{}"))).toEqual([{ widgets: 1 }]);
    expect(JSON.stringify(h.rows("SELECT * FROM audit_log"))).not.toMatch(/tajny/);
    expect(h.logLines().join("\n")).not.toMatch(/tajny/);
  });
});
