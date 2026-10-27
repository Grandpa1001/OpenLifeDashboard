// D15.3 — adding and listing records over real HTTP (Architektura §4.6, §5.4, §6, §18). The first
// block runs the built server process with an owner made by the CLI; the second composes the same
// application in the test process (tests/support/app-harness.ts) where a request can be stopped
// between its middleware and its unit of work, a write can fail, and the clock of an entry can be
// moved.
// AC1: Książki of F01 is filled through the API with 25 records, each under its own key, and lists
//      as 10/10/5 with the count 25 and the same after a restart; the same key and body twice is
//      one record and the same answer.
// AC2: a missing key, a key with another body, a stale schema revision, a missing required title,
//      a system or foreign field, an unknown registry, every state before the gate, a foreign
//      Origin, an ended session and a failing write are refused with their own code and leave no
//      record, entry or revision behind.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, recordPageSchema, recordSchema, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type AppHarness } from "../../support/app-harness.ts";
import { ack, chooseEmpty, codeOf, enrolled, installation, post, query, readyOwner, secretOf, send, serve, signIn, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
type FixtureRecord = { values: Record<string, unknown> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[]; records: FixtureRecord[] }> };
const expected = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { pageTitles: string[][] };
const BOOKS = fixture.registries[0]!;
const booksRequest = () => ({
  symbol: BOOKS.symbol,
  displayName: BOOKS.displayName,
  columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions, defaultValue, required })),
});
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const details = (reply: { json: () => unknown }): unknown => apiErrorSchema.parse(reply.json()).details;
const RECORDS = registryRecordsPath("ksiazki");
const keyed = (key: string) => ({ [IDEMPOTENCY_KEY_HEADER]: key });
const key = (n: number): string => `key-${String(n).padStart(6, "0")}`;

const counts = (setup: Installation) => ({ records: query(setup.instance, "SELECT 1 FROM reg_ksiazki").length, entries: query(setup.instance, "SELECT 1 FROM idempotency_entry").length, revision: query<{ data_revision: number }>(setup.instance, "SELECT data_revision FROM registry")[0]?.data_revision ?? null });

async function booksOwner(setup: Installation) {
  const owner = await readyOwner(setup);
  expect((await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie })).status).toBe(201);
  return owner;
}

describe("D15.3-AC1 F01 through the real API", () => {
  it("25 records, each under its own key, list as 10/10/5 with the count 25 in the order of the expected file, and the same after a restart", async () => {
    const setup = await installation();
    const owner = await booksOwner(setup);
    // The server gives its own identifiers and times, so the order of the list is the order of creation, newest first.
    for (const [index, record] of BOOKS.records.entries()) {
      const added = await post(setup.server, RECORDS, { schemaRevision: 1, values: record.values }, { cookie: owner.sessionCookie, headers: keyed(key(index)) });
      if (added.status !== 201) throw new Error(`record ${index} was ${added.status}: ${added.text}`);
    }
    const read = async (server: Installation["server"], page: number) => recordPageSchema.parse((await send(server, "GET", `${RECORDS}?page=${page}&pageSize=10`, undefined, { cookie: owner.sessionCookie })).json());
    const check = async (server: Installation["server"]) => {
      const pages = [await read(server, 1), await read(server, 2), await read(server, 3), await read(server, 4)];
      expect(pages.map((page) => page.records.length)).toEqual([10, 10, 5, 0]);
      expect(pages.map((page) => page.total)).toEqual([25, 25, 25, 25]);
      expect(pages.slice(0, 3).map((page) => page.records.map((record) => record.values["tytul"]))).toEqual(expected.pageTitles);
      expect(pages[0]).toMatchObject({ page: 1, pageSize: 10, schemaRevision: 1, dataRevision: 25 });
      return pages;
    };
    const pages = await check(setup.server);

    // What was sent is what is read: all nine values of every record, money in grosze, boolean as boolean, null as null.
    const all = pages.flatMap((page) => page.records);
    const sent = [...BOOKS.records].reverse();
    expect(all.map((record) => record.values)).toEqual(sent.map((record) => record.values));
    expect(all.every((record) => V7.test(record.id) && record.revision === 1 && record.createdAt === record.updatedAt)).toBe(true);
    expect(new Set(all.map((record) => record.id)).size).toBe(25);
    expect(Math.abs(Date.parse(all[0]!.createdAt) - Date.now())).toBeLessThan(60_000);
    // Nothing of the engine leaks into the public shape.
    expect(JSON.stringify(pages)).not.toMatch(/user_id|ownerId|registryId|table_?name|reg_ksiazki/i);

    await stopServer(setup.server);
    const again = await serve(setup.instance);
    expect(await check(again)).toEqual(pages);
    expect(counts(setup)).toEqual({ records: 25, entries: 25, revision: 25 });
  });

  it("the same key and the same body twice is one record and the same answer; the second answer is 200", async () => {
    const setup = await installation();
    const owner = await booksOwner(setup);
    const body = { schemaRevision: 1, values: { tytul: "Dune", autor: "Herbert", cena: 1037 } };
    const first = await post(setup.server, RECORDS, body, { cookie: owner.sessionCookie, headers: keyed("retry-after-loss") });
    const second = await post(setup.server, RECORDS, body, { cookie: owner.sessionCookie, headers: keyed("retry-after-loss") });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(recordSchema.parse(second.json())).toEqual(recordSchema.parse(first.json()));
    // The order of the keys of the values does not make a different request.
    const reordered = await post(setup.server, RECORDS, { values: { cena: 1037, autor: "Herbert", tytul: "Dune" }, schemaRevision: 1 }, { cookie: owner.sessionCookie, headers: keyed("retry-after-loss") });
    expect([reordered.status, recordSchema.parse(reordered.json()).id]).toEqual([200, recordSchema.parse(first.json()).id]);
    expect(counts(setup)).toEqual({ records: 1, entries: 1, revision: 1 });
    const listed = recordPageSchema.parse((await send(setup.server, "GET", RECORDS, undefined, { cookie: owner.sessionCookie })).json());
    expect([listed.total, listed.dataRevision, listed.pageSize]).toEqual([1, 1, 25]);
    expect(listed.records[0]?.values).toMatchObject({ tytul: "Dune", status: "planowane", ponowne_czytanie: false });
  });

  it("the parent smoke: a registry is made, 25 records go in, the pages follow", async () => {
    const setup = await installation();
    const owner = await booksOwner(setup);
    for (let index = 0; index < 25; index += 1) {
      expect((await post(setup.server, RECORDS, { schemaRevision: 1, values: { tytul: `Book ${index}` } }, { cookie: owner.sessionCookie, headers: keyed(key(index)) })).status).toBe(201);
    }
    const sizes: number[] = [];
    for (const page of [1, 2, 3]) sizes.push(recordPageSchema.parse((await send(setup.server, "GET", `${RECORDS}?page=${page}&pageSize=10`, undefined, { cookie: owner.sessionCookie })).json()).records.length);
    expect(sizes).toEqual([10, 10, 5]);
  });
});

describe("D15.3-AC2 every state before the gate, and the Origin", () => {
  it("each state is refused with its code on both routes before a registry or a key is looked at, and nothing is written", async () => {
    const setup = await installation();
    const { server } = setup;
    const refusal = async (cookie: string | null, expectedReply: [number, string]) => {
      const added = await post(server, RECORDS, { schemaRevision: 1, values: { tytul: "x" } }, { cookie, headers: keyed(key(1)) });
      const listed = await send(server, "GET", RECORDS, undefined, { cookie });
      expect([added.status, code(added)]).toEqual(expectedReply);
      expect([listed.status, code(listed)]).toEqual(expectedReply);
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
    expect((await chooseEmpty(server, session)).status).toBe(200);
    // The positive control of the same routes: the gate passed, the registry is not there.
    const missing = await post(server, RECORDS, { schemaRevision: 1, values: { tytul: "x" } }, { cookie: session, headers: keyed(key(1)) });
    expect([missing.status, code(missing)]).toEqual([404, "NOT_FOUND"]);
    expect(query(setup.instance, "SELECT 1 FROM idempotency_entry")).toEqual([]);
  });

  it("a new password session of a finished owner is before the second factor again", async () => {
    const setup = await installation();
    await booksOwner(setup);
    const password = (await signIn(setup.server)).cookie ?? "";
    const added = await post(setup.server, RECORDS, { schemaRevision: 1, values: { tytul: "x" } }, { cookie: password, headers: keyed(key(1)) });
    expect([added.status, code(added)]).toEqual([403, "MFA_REQUIRED"]);
    expect(counts(setup)).toEqual({ records: 0, entries: 0, revision: 0 });
  });

  it("a foreign, missing or null Origin cannot add a record, a session past the gate included", async () => {
    const setup = await installation();
    const owner = await booksOwner(setup);
    for (const origin of ["https://evil.example", null, "null", "http://localhost:8080.evil.example", "http://localhost:8081"]) {
      const reply = await send(setup.server, "POST", RECORDS, { schemaRevision: 1, values: { tytul: "x" } }, { cookie: owner.sessionCookie, origin, headers: keyed(key(1)) });
      expect([origin, reply.status, code(reply)]).toEqual([origin, 403, "ORIGIN_FORBIDDEN"]);
    }
    expect(counts(setup)).toEqual({ records: 0, entries: 0, revision: 0 });
  });
});

describe("D15.3-AC2 in the test process: what is refused and what is left behind", () => {
  async function signedIn() {
    const h = await createAppHarness();
    const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
    const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
    const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
    const cookie = confirmed.cookie ?? "";
    await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: (confirmed.json() as { batchId: string }).batchId }, { cookie });
    await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie });
    expect((await h.request("POST", REGISTRIES_PATH, booksRequest(), { cookie })).status).toBe(201);
    const add = (body: unknown, k: string | null = key(1), extra: Record<string, string> = {}) => h.request("POST", RECORDS, body, { cookie, headers: { ...(k === null ? {} : keyed(k)), ...extra } });
    const list = (queryString = "") => h.request("GET", `${RECORDS}${queryString}`, undefined, { cookie });
    return { h, cookie, add, list };
  }
  type Rig = Awaited<ReturnType<typeof signedIn>>;
  const state = (h: AppHarness) => ({
    records: h.rows("SELECT 1 FROM reg_ksiazki").length,
    entries: h.rows("SELECT 1 FROM idempotency_entry").length,
    revision: h.rows<{ data_revision: number }>("SELECT data_revision FROM registry")[0]?.data_revision,
  });
  const NONE = { records: 0, entries: 0, revision: 0 };
  const ok = { schemaRevision: 1, values: { tytul: "Dune" } };

  it("no key, a key of the wrong shape: 422 with the header named, and nothing is written", async () => {
    const { h, add } = await signedIn();
    const missing = await add(ok, null);
    expect([missing.status, code(missing), details(missing)]).toEqual([422, "VALIDATION_FAILED", { issues: [{ path: "header.Idempotency-Key", code: "KEY_MISSING" }] }]);
    for (const bad of ["short", "has space in it", "x".repeat(129), "key;DROP TABLE x", "a\tb-b-b-b-b", ""]) {
      const reply = await add(ok, bad);
      expect([JSON.stringify(bad), reply.status, code(reply)]).toEqual([JSON.stringify(bad), 422, "VALIDATION_FAILED"]);
    }
    expect(state(h)).toEqual(NONE);
  });

  it("the same key with another body is 409 IDEMPOTENCY_CONFLICT and keeps the first record; another key or another registry is a new add", async () => {
    const { h, cookie, add } = await signedIn();
    const first = await add(ok, "one-key-one-body");
    expect(first.status).toBe(201);
    const other = await add({ schemaRevision: 1, values: { tytul: "Dune II" } }, "one-key-one-body");
    expect([other.status, code(other)]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    const revision = await add({ schemaRevision: 2, values: { tytul: "Dune" } }, "one-key-one-body");
    expect([revision.status, code(revision)]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    expect(state(h)).toEqual({ records: 1, entries: 1, revision: 1 });
    expect((await add({ schemaRevision: 1, values: { tytul: "Dune II" } }, "another-key")).status).toBe(201);

    // The key is bound to the registry: the same key in a registry of its own is independent.
    const small = { symbol: "waga", displayName: "Waga", columns: [{ symbol: "kg", displayName: "Kg", type: "number" }] };
    expect((await h.request("POST", REGISTRIES_PATH, small, { cookie })).status).toBe(201);
    const elsewhere = await h.request("POST", registryRecordsPath("waga"), { schemaRevision: 1, values: { kg: 70 } }, { cookie, headers: keyed("one-key-one-body") });
    expect(elsewhere.status).toBe(201);
    expect(h.rows("SELECT 1 FROM idempotency_entry")).toHaveLength(3);
  });

  it("schemaRevision 0 and 2 are 409 SCHEMA_CHANGED and write nothing, 1 is accepted; a retry of an add made before the schema changed still gets its first answer", async () => {
    const { h, add } = await signedIn();
    for (const stale of [0, 2, 7]) {
      const reply = await add({ schemaRevision: stale, values: { tytul: "Dune" } }, key(stale));
      expect([stale, reply.status, code(reply)]).toEqual([stale, 409, "SCHEMA_CHANGED"]);
    }
    expect(state(h)).toEqual(NONE);
    const first = await add(ok, "made-before");
    expect(first.status).toBe(201);
    h.sql("UPDATE registry SET schema_revision = 2");
    const retry = await add(ok, "made-before");
    expect([retry.status, (retry.json() as { id: string }).id]).toEqual([200, (first.json() as { id: string }).id]);
    expect((await add({ schemaRevision: 1, values: { tytul: "Dune" } }, "made-after")).status).toBe(409);
    expect((await add({ schemaRevision: 2, values: { tytul: "Dune" } }, "made-after")).status).toBe(201);
    expect(h.rows("SELECT 1 FROM reg_ksiazki")).toHaveLength(2);
  });

  it("a missing, null or blank required title is 422 with the path and no partial record; every problem is listed", async () => {
    const { h, add } = await signedIn();
    for (const values of [{}, { tytul: null }, { tytul: "" }, { tytul: "   \n\t" }, { autor: "Herbert" }]) {
      const reply = await add({ schemaRevision: 1, values }, key(Math.random() * 1e6));
      expect([JSON.stringify(values), reply.status, code(reply), details(reply)]).toEqual([JSON.stringify(values), 422, "VALIDATION_FAILED", { issues: [{ path: "values.tytul", code: "VALUE_REQUIRED" }] }]);
    }
    const many = await add({ schemaRevision: 1, values: { cena: 10.37, data_ukonczenia: "2026-02-31", ponowne_czytanie: "tak", status: 5, extra: 1 } }, key(2));
    expect(details(many)).toEqual({
      issues: [
        { path: "values.extra", code: "FIELD_UNKNOWN" },
        { path: "values.tytul", code: "VALUE_REQUIRED" },
        { path: "values.cena", code: "VALUE_INVALID" },
        { path: "values.data_ukonczenia", code: "VALUE_INVALID" },
        { path: "values.ponowne_czytanie", code: "VALUE_INVALID" },
        { path: "values.status", code: "VALUE_INVALID" },
      ],
    });
    expect(state(h)).toEqual(NONE);
    // The money of the plan: 10.37 is refused, 1037 is accepted.
    expect((await add({ schemaRevision: 1, values: { tytul: "x", cena: 1037 } }, key(3))).status).toBe(201);
  });

  it("a system field, an owner or any field the contract does not know is refused, whoever it names", async () => {
    const { h, cookie, add } = await signedIn();
    for (const field of ["id", "user_id", "created_at", "updated_at", "revision"]) {
      const reply = await add({ schemaRevision: 1, values: { tytul: "x", [field]: "stranger" } }, key(field.length));
      expect([field, reply.status, details(reply)]).toEqual([field, 422, { issues: [{ path: `values.${field}`, code: "FIELD_SYSTEM" }] }]);
    }
    for (const extra of [{ ownerId: "someone-else" }, { id: "fixed" }, { userId: "x" }, { registryId: "x" }, { revision: 5 }, { createdAt: "2020-01-01T00:00:00.000Z" }]) {
      const reply = await add({ schemaRevision: 1, values: { tytul: "x" }, ...extra }, key(3));
      expect([JSON.stringify(extra), reply.status, code(reply)]).toEqual([JSON.stringify(extra), 422, "VALIDATION_FAILED"]);
    }
    // Shapes that are not a body of this contract.
    for (const body of [[], "text", null, 5, { values: [] }, { values: "x" }, { values: null }, { schemaRevision: "1", values: {} }, { schemaRevision: 1.5, values: {} }, { schemaRevision: -1, values: {} }, { schemaRevision: 1 }, { values: {} }]) {
      const reply = await add(body, key(4));
      expect([JSON.stringify(body), reply.status, code(reply)]).toEqual([JSON.stringify(body), 422, "VALIDATION_FAILED"]);
    }
    expect(state(h)).toEqual(NONE);
    // `__proto__` as a key is dropped by the parser of the body and reaches the prototype of nothing.
    const proto = await h.request("POST", RECORDS, '{"schemaRevision":1,"values":{"tytul":"x","__proto__":{"admin":true}}}', { cookie, headers: keyed(key(9)) });
    expect(proto.status).toBe(201);
    expect(Object.keys((proto.json() as { values: object }).values)).not.toContain("__proto__");
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
    expect(state(h)).toEqual({ records: 1, entries: 1, revision: 1 });
  });

  it("an unknown or deleted registry is 404 on both routes and nothing is written", async () => {
    const { h, cookie, add, list } = await signedIn();
    const where = registryRecordsPath("nope");
    const added = await h.request("POST", where, ok, { cookie, headers: keyed(key(1)) });
    const listed = await h.request("GET", where, undefined, { cookie });
    expect([added.status, code(added), listed.status, code(listed)]).toEqual([404, "NOT_FOUND", 404, "NOT_FOUND"]);
    for (const symbol of ["KSIAZKI", "ksiazki%00", "ksiazki;", "..", "ksiazki%2Fx"]) {
      const reply = await h.request("GET", registryRecordsPath(symbol), undefined, { cookie });
      expect([symbol, reply.status, code(reply)]).toEqual([symbol, 404, "NOT_FOUND"]);
    }
    h.sql(`UPDATE registry SET deleted_at = '2026-10-27T12:00:00.000Z'`);
    expect([(await add(ok, key(2))).status, (await list()).status]).toEqual([404, 404]);
    expect(h.rows("SELECT 1 FROM idempotency_entry")).toEqual([]);
  });

  it("the text and the record are bounded: 10 001 code points and a record over 192 KiB are 422 with their own codes", async () => {
    const { h, cookie, add } = await signedIn();
    expect(details(await add({ schemaRevision: 1, values: { tytul: "x".repeat(10_001) } }, key(1)))).toEqual({ issues: [{ path: "values.tytul", code: "VALUE_INVALID" }] });
    expect((await add({ schemaRevision: 1, values: { tytul: "📚".repeat(10_000) } }, key(2))).status).toBe(201);
    // Five texts of 10 000 four-byte characters: each is valid, together they are over the record's limit (5 x 40 000 bytes > 192 KiB).
    const wide = { symbol: "szerokie", displayName: "Szerokie", columns: ["a", "b", "c", "d", "e"].map((symbol) => ({ symbol, displayName: symbol, type: "text" })) };
    expect((await h.request("POST", REGISTRIES_PATH, wide, { cookie })).status).toBe(201);
    const huge = Object.fromEntries(["a", "b", "c", "d", "e"].map((symbol) => [symbol, "📚".repeat(10_000)]));
    const tooLarge = await h.request("POST", registryRecordsPath("szerokie"), { schemaRevision: 1, values: huge }, { cookie, headers: keyed(key(3)) });
    expect([tooLarge.status, details(tooLarge)]).toEqual([422, { issues: [{ path: "values", code: "RECORD_TOO_LARGE" }] }]);
    expect(h.rows("SELECT 1 FROM reg_szerokie")).toEqual([]);
    // A body over the limit of the route never reaches the rules.
    const body = await add({ schemaRevision: 1, values: { tytul: "x", pad: "y".repeat(300 * 1024) } }, key(4));
    expect([body.status, code(body)]).toEqual([422, "VALIDATION_FAILED"]);
    expect(state(h)).toEqual({ records: 1, entries: 1, revision: 1 });
  });

  it("a session that ends between the middleware and the unit adds nothing: 401, no record, no entry, no revision", async () => {
    const { h, add } = await signedIn();
    h.interruptNextWrite(() => h.sql(`DELETE FROM "session"`));
    const reply = await add(ok);
    expect([reply.status, code(reply)]).toEqual([401, "AUTH_REQUIRED"]);
    expect(state(h)).toEqual(NONE);
  });

  it("a failing write gives 503 with no record, entry or revision, and the same request with the same key works once the write does", async () => {
    const { h, add, list } = await signedIn();
    h.sql(`CREATE TRIGGER fail_write BEFORE INSERT ON reg_ksiazki BEGIN SELECT RAISE(ABORT, 'disk unavailable: secret-detail'); END;`);
    const failed = await add(ok, "kept-key");
    expect([failed.status, code(failed)]).toEqual([503, "AUTH_UNAVAILABLE"]);
    expect(failed.text).not.toContain("secret-detail");
    expect(h.logLines().join("\n")).not.toContain("secret-detail");
    expect(state(h)).toEqual(NONE);
    h.sql("DROP TRIGGER fail_write");
    const again = await add(ok, "kept-key");
    expect(again.status).toBe(201);
    expect(state(h)).toEqual({ records: 1, entries: 1, revision: 1 });

    // A failing entry takes the record back too.
    h.sql(`CREATE TRIGGER fail_entry BEFORE INSERT ON idempotency_entry BEGIN SELECT RAISE(ABORT, 'entry unavailable'); END;`);
    expect((await add({ schemaRevision: 1, values: { tytul: "Two" } }, "second-key")).status).toBe(503);
    expect(state(h)).toEqual({ records: 1, entries: 1, revision: 1 });
    h.sql("DROP TRIGGER fail_entry");
    expect(((await list()).json() as { total: number }).total).toBe(1);
  });

  it("five parallel requests with one key and one body: one record, one 201 and four 200 with the same answer", async () => {
    const { h, add } = await signedIn();
    const replies = await Promise.all([1, 2, 3, 4, 5].map(() => add(ok, "parallel-key")));
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(replies.map((reply) => (reply.json() as { id: string }).id)).size).toBe(1);
    expect(state(h)).toEqual({ records: 1, entries: 1, revision: 1 });
  });

  it("an entry lives 24 hours: after that the key adds a new record, and the entry holds the answer and a hash, not the request", async () => {
    const { h, add } = await signedIn();
    const first = await add({ schemaRevision: 1, values: { tytul: "Secret title", autor: "Secret author" } }, "daily-key");
    expect(first.status).toBe(201);
    const [entry] = h.rows<{ created_at: string; expires_at: string; request_hash: string; response: string }>("SELECT * FROM idempotency_entry");
    expect(Date.parse(entry!.expires_at) - Date.parse(entry!.created_at)).toBe(24 * 60 * 60 * 1000);
    expect(entry!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(entry!.response)).toMatchObject({ values: { tytul: "Secret title" } });
    h.sql(`UPDATE idempotency_entry SET created_at = '2020-01-01T00:00:00.000Z', expires_at = '2020-01-02T00:00:00.000Z'`);
    const later = await add({ schemaRevision: 1, values: { tytul: "Secret title", autor: "Secret author" } }, "daily-key");
    expect(later.status).toBe(201);
    expect((later.json() as { id: string }).id).not.toBe((first.json() as { id: string }).id);
    expect(state(h)).toEqual({ records: 2, entries: 1, revision: 2 });
  });

  it("records are not audited one by one, and neither the audit nor the log holds a value", async () => {
    const { h, add } = await signedIn();
    const before = h.rows("SELECT * FROM audit_log").length;
    await add({ schemaRevision: 1, values: { tytul: "Tytuł-tajny", autor: "Autor-tajny" } }, key(1));
    expect(h.rows("SELECT * FROM audit_log")).toHaveLength(before);
    expect(JSON.stringify(h.rows("SELECT * FROM audit_log"))).not.toMatch(/tajny/);
    expect(h.logLines().join("\n")).not.toMatch(/tajny/);
  });

  describe("the list", () => {
    async function filled(): Promise<Rig> {
      const rig = await signedIn();
      const books = [
        { tytul: "C", autor: "B", cena: 300 },
        { tytul: "A", autor: null, cena: 100 },
        { tytul: "B", autor: "A", cena: null },
        { tytul: "D", autor: "B", cena: 200 },
      ];
      for (const [index, values] of books.entries()) expect((await rig.add({ schemaRevision: 1, values }, key(index))).status).toBe(201);
      return rig;
    }
    const titles = (reply: { json: () => unknown }): string[] => recordPageSchema.parse(reply.json()).records.map((record) => String(record.values["tytul"]));

    it("the default is the newest first, 25 to a page; the sort and the direction are the request's, empty values last, ties by identifier", async () => {
      const { list } = await filled();
      expect(titles(await list())).toEqual(["D", "B", "A", "C"]);
      expect(titles(await list("?sort=created_at&direction=asc"))).toEqual(["C", "A", "B", "D"]);
      expect(titles(await list("?sort=tytul&direction=asc"))).toEqual(["A", "B", "C", "D"]);
      expect(titles(await list("?sort=autor&direction=asc"))).toEqual(["B", "C", "D", "A"]);
      expect(titles(await list("?sort=autor&direction=desc"))).toEqual(["D", "C", "B", "A"]);
      expect(titles(await list("?sort=cena&direction=desc"))).toEqual(["C", "D", "A", "B"]);
      expect(titles(await list("?sort=id&direction=asc"))).toEqual(["C", "A", "B", "D"]);
      expect(titles(await list("?page=2&pageSize=3"))).toEqual(["C"]);
      expect(recordPageSchema.parse((await list("?pageSize=100")).json())).toMatchObject({ page: 1, pageSize: 100, total: 4 });
    });

    it("a sort, a page, a size, a direction or a repeated parameter is 422 and never reaches SQL; a parameter the contract does not know is not read", async () => {
      const { h, list } = await filled();
      const tables = h.rows<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name");
      const sortIssue = { issues: [{ path: "sort", code: "SORT_UNKNOWN" }] };
      for (const sort of ["unknown", "user_id", "revision", "TYTUL", "tytul;DROP TABLE reg_ksiazki", encodeURIComponent('tytul"; DROP TABLE "user"; --'), "tytul%00", "reg_ksiazki.tytul", "%27", ""]) {
        const reply = await list(`?sort=${sort}`);
        expect([sort, reply.status, details(reply)]).toEqual([sort, 422, sortIssue]);
      }
      for (const [parameter, value, issue] of [["page", "0", "PAGE_OUT_OF_RANGE"], ["pageSize", "0", "PAGE_SIZE_OUT_OF_RANGE"], ["pageSize", "101", "PAGE_SIZE_OUT_OF_RANGE"]] as const) {
        const reply = await list(`?${parameter}=${value}`);
        expect([parameter, value, reply.status, details(reply)]).toEqual([parameter, value, 422, { issues: [{ path: parameter, code: issue }] }]);
      }
      for (const queryString of ["?page=abc", "?page=-1", "?page=1.5", "?page=1e3", "?pageSize=%201", "?pageSize=0x10", "?page=1234567890", "?direction=up", "?direction=ASC", "?direction=asc;drop", "?page=1&page=2x", "?sort=tytul&sort=autor"]) {
        const reply = await list(queryString);
        expect([queryString, reply.status, code(reply)]).toEqual([queryString, 422, "VALIDATION_FAILED"]);
      }
      // An owner, a user or a registry named in the query decides nothing: the answer is the plain one.
      const plain = await list();
      for (const queryString of ["?owner=x", "?userId=x&registry=other", "?ownerId=owner-1&sessionId=s"]) {
        const reply = await list(queryString);
        expect([queryString, reply.status, reply.text]).toEqual([queryString, 200, plain.text]);
      }
      expect(h.rows<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name")).toEqual(tables);
      expect(h.rows("SELECT 1 FROM reg_ksiazki")).toHaveLength(4);
    });

    it("hostile text is a value only: it is stored and listed as it was sent, and the answer is JSON", async () => {
      const { h, add, list } = await signedIn();
      const texts = ["'; DROP TABLE reg_ksiazki; --", "<img src=x onerror=alert(1)>", "line\nbreak", "Zażółć gęślą jaźń 📚", "\"quoted\"", "?"];
      for (const [index, text] of texts.entries()) expect((await add({ schemaRevision: 1, values: { tytul: text, autor: text } }, key(index))).status).toBe(201);
      const reply = await list("?sort=created_at&direction=asc");
      expect(reply.status).toBe(200);
      expect(recordPageSchema.parse(reply.json()).records.map((record) => record.values["tytul"])).toEqual(texts);
      expect(h.rows("SELECT 1 FROM reg_ksiazki")).toHaveLength(texts.length);
    });
  });
});
