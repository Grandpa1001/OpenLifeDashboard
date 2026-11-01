// D24.2 — dictionaries and their labels over real HTTP on the built server (Scope §5.8, §6.2, S7;
// Architektura §5.2, §5.4, §6), on F01 made through the API: its dictionary, Książki with "Status"
// on it, the 25 records and a register table showing the status.
// AC1: the page of records and the data of the widget carry the labels of the page, the hidden one
//      too, and none for `spoza_slownika`; the list has the number of values and the column that
//      uses the dictionary; deleting it unpins the column, the labels go and the records are as they
//      were (S7).
// AC2: two saves of revision 1 are 200 and 409; the rules refuse with their paths; a taken symbol,
//      an unknown dictionary of a column, a foreign Origin and a dictionary of another installation
//      are refused; a record with a symbol the dictionary does not have is stored.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { DICTIONARIES_PATH, dictionaryDeletedSchema, dictionaryListSchema, dictionaryPath, dictionarySchema } from "@openlife/contracts/http/dictionaries";
import { IDEMPOTENCY_KEY_HEADER, recordPageSchema, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, registryListSchema, type RegistryDto } from "@openlife/contracts/http/registries";
import { SCREENS_PATH, screenDesignPath, screenSchema, widgetDataPath, widgetDataSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { installation, post, query, readyOwner, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(stopServers);

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: Record<string, unknown>; defaultValue: unknown; required: boolean };
type FixtureDictionary = { symbol: string; displayName: string; values: Array<{ symbol: string; label: string; hidden: boolean }> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { dictionaries: FixtureDictionary[]; registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ values: Record<string, unknown> }> }> };
const expected = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { statusCounts: Record<string, number>; hiddenLabel: string; unknownValueDisplayedAs: string };
const STATUS = fixture.dictionaries[0]!;
const BOOKS = fixture.registries[0]!;
const WIDGET = "019a0000-0000-7000-8000-0000000d2402";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 8, h: 8 } };
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const issues = (reply: { json: () => unknown }): unknown => apiErrorSchema.parse(reply.json()).details?.["issues"];
const statusDraft = () => ({ symbol: STATUS.symbol, displayName: STATUS.displayName, values: STATUS.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })) });
const booksWith = (dictionaryId: string | null) => ({
  symbol: BOOKS.symbol,
  displayName: BOOKS.displayName,
  columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: symbol === "status" ? (dictionaryId === null ? {} : { dictionaryId }) : typeOptions, defaultValue, required })),
});

/** The dictionary of F01 and Książki on it, through the API. */
async function f01(setup: Installation, records = true): Promise<{ cookie: string; dictionaryId: string; registry: RegistryDto }> {
  const cookie = (await readyOwner(setup)).sessionCookie;
  const created = await post(setup.server, DICTIONARIES_PATH, statusDraft(), { cookie });
  expect(created.status).toBe(201);
  const dictionaryId = dictionarySchema.parse(created.json()).id;
  expect((await post(setup.server, REGISTRIES_PATH, booksWith(dictionaryId), { cookie })).status).toBe(201);
  if (records) {
    for (const [index, record] of BOOKS.records.entries()) {
      expect((await post(setup.server, registryRecordsPath(BOOKS.symbol), { schemaRevision: 1, values: record.values }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `d24-2-${String(index).padStart(3, "0")}` } })).status).toBe(201);
    }
  }
  const registry = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries[0]!;
  return { cookie, dictionaryId, registry };
}

const allRecords = async (setup: Installation, cookie: string) => recordPageSchema.parse((await send(setup.server, "GET", `${registryRecordsPath(BOOKS.symbol)}?pageSize=100`, undefined, { cookie })).json());
const stored = (setup: Installation) => query(setup.instance, `SELECT * FROM reg_${BOOKS.symbol} ORDER BY id`);

describe("D24.2-AC1 the labels of F01 and the deletion of its dictionary (S7)", () => {
  it("the page and the widget carry the labels of their values, the hidden one too and none for an unknown symbol; deleting the dictionary takes the labels away and leaves the records", async () => {
    const setup = await installation();
    const { cookie, dictionaryId, registry } = await f01(setup);

    // The page: every label of the dictionary the page holds, the hidden "Archiwalne" among them, nothing for spoza_slownika.
    const page = await allRecords(setup, cookie);
    expect(page.total).toBe(25);
    expect(page.labels).toEqual({ status: { planowane: "Planowane", czytane: "W trakcie", ukonczone: "Ukończone", archiwalne: expected.hiddenLabel } });
    const shown = page.records.map((record) => page.labels["status"]?.[record.values["status"] as string] ?? (record.values["status"] as string));
    const counts = shown.reduce<Record<string, number>>((all, each) => ({ ...all, [each]: (all[each] ?? 0) + 1 }), {});
    expect(counts).toEqual({ Planowane: 5, "W trakcie": 5, Ukończone: 5, [expected.hiddenLabel]: 5, [expected.unknownValueDisplayedAs]: 5 });
    // The values themselves are the symbols, as stored.
    expect(page.records.map((record) => record.values["status"]).sort()).toEqual(BOOKS.records.map((record) => record.values["status"]).sort());

    // A page holds only its own labels.
    const firstFive = recordPageSchema.parse((await send(setup.server, "GET", `${registryRecordsPath(BOOKS.symbol)}?pageSize=5&sort=created_at&direction=asc`, undefined, { cookie })).json());
    const firstStatuses = new Set(firstFive.records.map((record) => record.values["status"] as string).filter((status) => status !== expected.unknownValueDisplayedAs));
    expect(Object.keys(firstFive.labels["status"] ?? {}).sort()).toEqual([...firstStatuses].sort());

    // The widget on the screen: the same labels by the key of its column.
    const screen = screenSchema.parse((await post(setup.server, SCREENS_PATH, { name: "Pulpit" }, { cookie })).json());
    const column = (symbol: string) => registry.columns.find((each) => each.symbol === symbol)!;
    const widget = {
      id: WIDGET,
      type: "register-table",
      config: { v: 1, title: "Statusy", pageSize: 100, sortDirection: "desc", allowAdd: true },
      layout: LAYOUT,
      bindings: [
        { slot: "registry", ordinal: 0, path: `Field.Register.${BOOKS.symbol}`, target: { kind: "registry", registryId: registry.id } },
        ...["tytul", "status"].map((symbol, ordinal) => ({ slot: "columns", ordinal, path: `Field.Register.${BOOKS.symbol}.${symbol}`, target: { kind: "column", registryId: registry.id, columnId: column(symbol).id } })),
        { slot: "sortColumn", ordinal: 0, path: `Field.Register.${BOOKS.symbol}.created_at`, target: { kind: "systemColumn", registryId: registry.id, symbol: "created_at" } },
      ],
    };
    expect((await send(setup.server, "PUT", screenDesignPath(screen.id), { name: "Pulpit", theme: "dark", accent: "blue", widgets: [widget] }, { cookie })).status).toBe(200);
    const data = widgetDataSchema.parse((await send(setup.server, "GET", widgetDataPath(WIDGET), undefined, { cookie })).json());
    expect(data.state).toBe("ok");
    expect(data.labels).toEqual(page.labels);

    // The list: the number of values and the column that uses the dictionary.
    const listed = dictionaryListSchema.parse((await send(setup.server, "GET", DICTIONARIES_PATH, undefined, { cookie })).json());
    expect(listed.dictionaries.map((each) => ({ symbol: each.symbol, values: each.values.length, usages: each.usages }))).toEqual([
      { symbol: STATUS.symbol, values: 4, usages: [{ registrySymbol: BOOKS.symbol, registryName: BOOKS.displayName, columnSymbol: "status", columnName: "Status" }] },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/user_id|ownerId/);

    // S7: the dictionary goes; the column is plain "choice", no label is left, and not one record changed.
    const before = stored(setup);
    const deleted = await send(setup.server, "DELETE", dictionaryPath(STATUS.symbol), { expectedRevision: 1 }, { cookie });
    expect(deleted.status).toBe(200);
    expect(dictionaryDeletedSchema.parse(deleted.json()).unpinned).toEqual([{ registrySymbol: BOOKS.symbol, registryName: BOOKS.displayName, columnSymbol: "status", columnName: "Status" }]);
    const after = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries[0]!;
    expect(after.columns.find((each) => each.symbol === "status")).toMatchObject({ type: "choice", typeOptions: {} });
    expect(after.schemaRevision).toBe(registry.schemaRevision + 1);
    const plain = await allRecords(setup, cookie);
    expect(plain.labels).toEqual({});
    expect(plain.records.map((record) => record.values)).toEqual(page.records.map((record) => record.values));
    expect(stored(setup)).toEqual(before);
    expect(widgetDataSchema.parse((await send(setup.server, "GET", widgetDataPath(WIDGET), undefined, { cookie })).json()).labels).toEqual({});
    expect((await send(setup.server, "GET", dictionaryPath(STATUS.symbol), undefined, { cookie })).status).toBe(404);
    expect(dictionaryId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("D24.2-AC2 what the dictionary routes refuse", () => {
  it("two saves of revision 1: one 200 with revision 2, the other 409 without a write; the rules refuse with their paths; a taken symbol is 409", async () => {
    const setup = await installation();
    const { cookie } = await f01(setup, false);
    const save = (body: unknown) => send(setup.server, "PUT", dictionaryPath(STATUS.symbol), body, { cookie });
    const reordered = { expectedRevision: 1, displayName: "Status", values: [{ symbol: "ukonczone", label: "Przeczytana" }, { symbol: "planowane", label: "W planie", hidden: true }] };
    const first = await save(reordered);
    expect(first.status).toBe(200);
    expect(dictionarySchema.parse(first.json())).toMatchObject({ revision: 2, values: [{ symbol: "ukonczone", label: "Przeczytana", hidden: false }, { symbol: "planowane", label: "W planie", hidden: true }], usages: [{ columnSymbol: "status" }] });
    const before = query(setup.instance, "SELECT * FROM dictionary_value ORDER BY position");
    const second = await save({ ...reordered, displayName: "Inny" });
    expect([second.status, code(second)]).toEqual([409, "DICTIONARY_CHANGED"]);
    expect(query(setup.instance, "SELECT * FROM dictionary_value ORDER BY position")).toEqual(before);

    const bad = await save({ expectedRevision: 2, displayName: " ", values: [{ symbol: "a", label: "A" }, { symbol: "a", label: "B" }, { symbol: "Zle", label: "C" }] });
    expect([bad.status, issues(bad)]).toEqual([422, [{ path: "displayName", code: "NAME_EMPTY" }, { path: "values.1.symbol", code: "SYMBOL_TAKEN" }, { path: "values.2.symbol", code: "SYMBOL_PATTERN" }]]);
    for (const body of [{ displayName: "X", values: [] }, { expectedRevision: 0, displayName: "X", values: [] }, { expectedRevision: 2, displayName: "X", values: [], ownerId: "x" }, "{"]) {
      const reply = await save(body);
      expect([reply.status, code(reply)], JSON.stringify(body)).toEqual([422, "VALIDATION_FAILED"]);
    }
    const taken = await post(setup.server, DICTIONARIES_PATH, statusDraft(), { cookie });
    expect([taken.status, code(taken)]).toEqual([409, "DICTIONARY_SYMBOL_TAKEN"]);
    const stale = await send(setup.server, "DELETE", dictionaryPath(STATUS.symbol), { expectedRevision: 1 }, { cookie });
    expect([stale.status, code(stale)]).toEqual([409, "DICTIONARY_CHANGED"]);
    expect(query(setup.instance, "SELECT revision FROM dictionary")).toEqual([{ revision: 2 }]);
  });

  it("a column cannot name a dictionary the owner does not have; a record with a symbol the dictionary does not have is stored", async () => {
    const setup = await installation();
    const { cookie } = await f01(setup, false);
    const unknown = await post(setup.server, REGISTRIES_PATH, { ...booksWith("019a0000-0000-7000-8000-00000000ffff"), symbol: "inne" }, { cookie });
    expect([unknown.status, issues(unknown)]).toEqual([422, [{ path: "columns.8.typeOptions.dictionaryId", code: "DICTIONARY_UNKNOWN" }]]);
    const added = await post(setup.server, registryRecordsPath(BOOKS.symbol), { schemaRevision: 1, values: { tytul: "Spoza", status: "nie_ma_w_slowniku" } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: "d24-2-unknown-symbol" } });
    expect(added.status).toBe(201);
    expect((await allRecords(setup, cookie)).labels).toEqual({});
  });

  it("a foreign Origin, an unknown dictionary and a dictionary of another installation are refused and change nothing", async () => {
    const setup = await installation();
    const { cookie } = await f01(setup, false);
    const other = await installation();
    const elsewhere = await f01(other, false);
    const before = query(setup.instance, "SELECT * FROM dictionary");
    for (const [method, route, body] of [["POST", DICTIONARIES_PATH, { symbol: "kraje", displayName: "Kraje" }], ["PUT", dictionaryPath(STATUS.symbol), { expectedRevision: 1, displayName: "X", values: [] }], ["DELETE", dictionaryPath(STATUS.symbol), { expectedRevision: 1 }]] as const) {
      const reply = await send(setup.server, method, route, body, { cookie, origin: "https://evil.example" });
      expect([reply.status, code(reply)], `${method} ${route}`).toEqual([403, "ORIGIN_FORBIDDEN"]);
    }
    for (const [method, body] of [["GET", undefined], ["PUT", { expectedRevision: 1, displayName: "X", values: [] }], ["DELETE", { expectedRevision: 1 }]] as const) {
      const reply = await send(setup.server, method, dictionaryPath("nieznany"), body, { cookie });
      expect([reply.status, code(reply)], method).toEqual([404, "NOT_FOUND"]);
    }
    // The cookie of the other installation opens nothing here, and its dictionary stays its own.
    expect((await send(setup.server, "GET", DICTIONARIES_PATH, undefined, { cookie: elsewhere.cookie })).status).toBe(401);
    expect(query(setup.instance, "SELECT * FROM dictionary")).toEqual(before);
    expect(query(other.instance, "SELECT symbol FROM dictionary")).toEqual([{ symbol: STATUS.symbol }]);
  });
});
