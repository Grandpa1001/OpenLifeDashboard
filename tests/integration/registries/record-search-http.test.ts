// D23.2 — the search of a list of records over real HTTP on the built server (Architektura §4.5
// p. 10, §6), on Książki of F01 added through the API.
// AC1: a fragment of a title, an author or a status returns exactly the records that hold it in any
//      letter case, Polish letters included, with their count, also sorted by title and in pages.
// AC2: `%` and `_` are text; a search of 101 code points and a parameter given twice are 422; a
//      search of white space is no filter.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, recordPageSchema, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { installation, post, readyOwner, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";
import { withoutDictionary } from "../../support/books-fixture.ts";

afterEach(stopServers);

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ values: Record<string, unknown> }> }> };
const BOOKS = fixture.registries[0]!;
const RECORDS = registryRecordsPath(BOOKS.symbol);
const TEXTUAL = BOOKS.columns.filter((column) => column.type === "text" || column.type === "choice").map((column) => column.symbol);
const fold = (text: string) => text.normalize("NFC").toLowerCase();
/** The records of F01 a fragment is in, by the rule of §9.19: any textual column, letter case aside. */
const matching = (fragment: string) => BOOKS.records.filter((record) => TEXTUAL.some((symbol) => typeof record.values[symbol] === "string" && fold(record.values[symbol] as string).includes(fold(fragment.trim()))));

async function books(): Promise<{ setup: Installation; cookie: string }> {
  const setup = await installation();
  const cookie = (await readyOwner(setup)).sessionCookie;
  const definition = { symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })) };
  expect((await post(setup.server, REGISTRIES_PATH, definition, { cookie })).status).toBe(201);
  for (const [index, record] of BOOKS.records.entries()) {
    expect((await post(setup.server, RECORDS, { schemaRevision: 1, values: record.values }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `d23-2-add-${String(index).padStart(2, "0")}` } })).status).toBe(201);
  }
  return { setup, cookie };
}

const list = async (setup: Installation, cookie: string, params: Record<string, string>) => send(setup.server, "GET", `${RECORDS}?${new URLSearchParams(params).toString()}`, undefined, { cookie });
const page = async (setup: Installation, cookie: string, params: Record<string, string>) => {
  const reply = await list(setup, cookie, params);
  expect(reply.status, JSON.stringify(params)).toBe(200);
  return recordPageSchema.parse(reply.json());
};

describe("D23.2-AC1 a search of F01 through the real API", () => {
  it("a fragment of a title, an author or a status finds exactly its records in any letter case, with the count, sorted and in pages", async () => {
    const { setup, cookie } = await books();
    for (const fragment of ["testowa 1", "KSIĄŻKA TESTOWA 2", "autor testowy 4", "Ukończone", "PLANOWANE", "zzz"]) {
      const found = await page(setup, cookie, { search: fragment, pageSize: "100" });
      const want = matching(fragment);
      expect(found.total, fragment).toBe(want.length);
      expect(found.records.map((record) => record.values["tytul"]).sort(), fragment).toEqual(want.map((record) => record.values["tytul"]).sort());
    }
    expect(matching("KSIĄŻKA TESTOWA 2").length).toBeGreaterThan(1);
    expect((await page(setup, cookie, { search: "zzz" })).total).toBe(0);

    // Sorted by title ascending, in pages of 3: the order of the fixture's titles, the count of all matches on each page.
    const want = matching("testowa 1").map((record) => record.values["tytul"] as string).sort();
    const pages = [await page(setup, cookie, { search: "testowa 1", sort: "tytul", direction: "asc", pageSize: "3", page: "1" }), await page(setup, cookie, { search: "testowa 1", sort: "tytul", direction: "asc", pageSize: "3", page: "2" })];
    expect(pages.flatMap((each) => each.records.map((record) => record.values["tytul"]))).toEqual(want.slice(0, 6));
    expect(pages.map((each) => each.total)).toEqual([want.length, want.length]);
    // The search does not change what the page says about the registry.
    expect(pages[0]).toMatchObject({ schemaRevision: 1, dataRevision: 25 });
  });
});

describe("D23.2-AC2 what a search refuses and what it takes as text", () => {
  it("`%` and `_` are text; 101 code points and a search given twice are 422; white space is no filter", async () => {
    const { setup, cookie } = await books();
    // `_` is in one status of F01 (`spoza_slownika`) and `%` in none: as wildcards both would match every record.
    expect((await page(setup, cookie, { search: "%", pageSize: "100" })).total).toBe(0);
    expect((await page(setup, cookie, { search: "_", pageSize: "100" })).total).toBe(matching("_").length);
    expect(matching("_").length).toBeLessThan(25);
    expect((await page(setup, cookie, { search: "a%a" })).total).toBe(0);

    const tooLong = await list(setup, cookie, { search: "ł".repeat(101) });
    expect(tooLong.status).toBe(422);
    expect(apiErrorSchema.parse(tooLong.json()).details).toEqual({ issues: [{ path: "search", code: "SEARCH_TOO_LONG" }] });
    expect((await page(setup, cookie, { search: ` ${"ł".repeat(100)} ` })).total).toBe(0);

    const twice = await send(setup.server, "GET", `${RECORDS}?search=a&search=b`, undefined, { cookie });
    expect([twice.status, apiErrorSchema.parse(twice.json()).code]).toEqual([422, "VALIDATION_FAILED"]);
    expect((await page(setup, cookie, { search: "   ", pageSize: "100" })).total).toBe(25);
    expect((await page(setup, cookie, { search: "' OR 1=1 --", pageSize: "100" })).total).toBe(0);
  });
});
