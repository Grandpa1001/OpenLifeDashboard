// D14.3 — creating and listing registries over real HTTP (Architektura §5.1, §6, §18). The first
// block runs the built server process with an owner made by the CLI; the second composes the same
// application in the test process (tests/support/app-harness.ts) where a request can be stopped
// between its middleware and its unit of work, an audit can fail, and many registries can be made
// quickly.
// AC1: the owner past the gate and the empty start creates Książki of F01 and lists it, the server
//      gives the identifiers, the owner and the timestamps, and a restart changes nothing.
// AC2: every earlier state, a foreign Origin, a field the client may not send, a bad or taken
//      symbol, the limits, an oversized body, an ended session and a failing audit are refused
//      with their own code and leave neither a catalog row nor a table.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { registryListSchema, registrySchema, REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { ack, chooseEmpty, codeOf, enrolled, execute, installation, post, query, readyOwner, secretOf, send, serve, signIn, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean; position: number };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[] }> };
const BOOKS = fixture.registries[0]!;
/** What a client sends: the definition, without the identifiers and positions of the export. */
const booksRequest = () => ({
  symbol: BOOKS.symbol,
  displayName: BOOKS.displayName,
  columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions, defaultValue, required })),
});
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const issuesOf = (reply: { json: () => unknown }): unknown => apiErrorSchema.parse(reply.json()).details;

const catalog = (setup: Installation) => ({ registries: query(setup.instance, "SELECT 1 FROM registry").length, columns: query(setup.instance, "SELECT 1 FROM registry_column").length });
const tables = (setup: Installation): string[] => query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master WHERE name LIKE 'reg\\_%' ESCAPE '\\' OR name LIKE 'idx\\_reg\\_%' ESCAPE '\\'").map((row) => row.name);
const untouched = (setup: Installation) => expect([catalog(setup), tables(setup)]).toEqual([{ registries: 0, columns: 0 }, []]);

describe("D14.3-AC1 the owner creates and lists Książki of F01", () => {
  it("creates it (201), the server gives the identifiers, the owner and the timestamps, and the list returns the same", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const created = await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const registry = registrySchema.parse(created.json());
    expect(registry).toMatchObject({ symbol: "ksiazki", displayName: "Książki", schemaRevision: 1, dataRevision: 0 });
    expect(registry.id).toMatch(V7);
    expect(registry.createdAt).toBe(registry.updatedAt);
    expect(Math.abs(Date.parse(registry.createdAt) - Date.now())).toBeLessThan(60_000);
    expect(registry.columns.map((column) => column.id).every((id) => V7.test(id))).toBe(true);
    expect(new Set([registry.id, ...registry.columns.map((column) => column.id)]).size).toBe(10);
    expect(registry.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required, position }) => ({ symbol, displayName, type, typeOptions, defaultValue, required, position }))).toEqual(
      BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required, position }) => ({ symbol, displayName, type, typeOptions, defaultValue, required, position })),
    );
    // Nothing of the engine leaks into the public shape.
    expect(created.text).not.toMatch(/user_id|ownerId|table_?name|reg_ksiazki/i);

    const rows = query<{ user_id: string; table_name: string }>(setup.instance, "SELECT user_id, table_name FROM registry");
    expect(rows).toEqual([{ user_id: query<{ id: string }>(setup.instance, `SELECT id FROM "user"`)[0]?.id, table_name: "reg_ksiazki" }]);
    expect(tables(setup).sort()).toEqual(["idx_reg_ksiazki_data_ukonczenia", "idx_reg_ksiazki_rozpoczeto", "reg_ksiazki"]);
    expect(query(setup.instance, "SELECT * FROM audit_log WHERE action = 'registry.created'")).toHaveLength(1);

    const listed = await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie: owner.sessionCookie });
    expect(listed.status).toBe(200);
    expect(registryListSchema.parse(listed.json()).registries).toEqual([registry]);
  });

  it("an empty list before the first registry, and the same registry after a restart", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const empty = await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie: owner.sessionCookie });
    expect(empty.json()).toEqual({ registries: [] });
    const created = registrySchema.parse((await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie })).json());

    await stopServer(setup.server);
    const again = { instance: setup.instance, server: await serve(setup.instance) };
    // The session of the owner is the database's, so the cookie still works after the restart.
    const listed = await send(again.server, "GET", REGISTRIES_PATH, undefined, { cookie: owner.sessionCookie });
    expect(registryListSchema.parse(listed.json()).registries).toEqual([created]);
  });

  it("two registries are listed in the order they were made, and a registry of a smaller kind works as well", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const small = { symbol: "waga", displayName: "Waga (kg)", columns: [{ symbol: "kg", displayName: "Kg", type: "number", typeOptions: { decimalPlaces: 1 }, required: true }] };
    const first = registrySchema.parse((await post(setup.server, REGISTRIES_PATH, small, { cookie: owner.sessionCookie })).json());
    const second = registrySchema.parse((await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie })).json());
    expect(first.id < second.id).toBe(true);
    const listed = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie: owner.sessionCookie })).json());
    expect(listed.registries.map((registry) => registry.symbol)).toEqual(["waga", "ksiazki"]);
    expect(first.columns[0]).toMatchObject({ typeOptions: { decimalPlaces: 1 }, defaultValue: null, required: true });
  });
});

describe("D14.3-AC2 what is refused, and what is left behind", () => {
  it("every state before the gate is refused with its code on both routes, and nothing is created", async () => {
    const setup = await installation();
    const { server } = setup;
    const refusal = async (cookie: string | null, expected: [number, string]) => {
      const created = await post(server, REGISTRIES_PATH, booksRequest(), { cookie });
      const listed = await send(server, "GET", REGISTRIES_PATH, undefined, { cookie });
      expect([created.status, code(created)]).toEqual(expected);
      expect([listed.status, code(listed)]).toEqual(expected);
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
    untouched(setup);
    // The positive control of the same routes once the data are chosen.
    expect((await chooseEmpty(server, session)).status).toBe(200);
    expect((await post(server, REGISTRIES_PATH, booksRequest(), { cookie: session })).status).toBe(201);
  });

  it("a new password session of a finished owner is before the second factor again", async () => {
    const setup = await installation();
    await readyOwner(setup);
    const password = (await signIn(setup.server)).cookie ?? "";
    const created = await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: password });
    expect([created.status, code(created)]).toEqual([403, "MFA_REQUIRED"]);
    untouched(setup);
  });

  it("a foreign, missing or null Origin cannot create a registry, a session past the gate included", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    for (const origin of ["https://evil.example", null, "null", "http://localhost:8080.evil.example", "http://localhost:8081"]) {
      const reply = await send(setup.server, "POST", REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie, origin });
      expect([origin, reply.status, code(reply)]).toEqual([origin, 403, "ORIGIN_FORBIDDEN"]);
    }
    untouched(setup);
  });

  it("a field the client may not send is refused by the strict contract, in the registry and in a column", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const privileged = { ownerId: "x", user_id: "x", userId: "x", id: "019a0000-0000-7000-8000-000000000001", schemaRevision: 9, dataRevision: 9, createdAt: "2020-01-01T00:00:00Z", tableName: "user", deletedAt: null, revision: 5 };
    for (const [key, value] of Object.entries(privileged)) {
      const atRegistry = await post(setup.server, REGISTRIES_PATH, { ...booksRequest(), [key]: value }, { cookie: owner.sessionCookie });
      expect([key, atRegistry.status, code(atRegistry)]).toEqual([key, 422, "VALIDATION_FAILED"]);
      const request = booksRequest();
      const atColumn = await post(setup.server, REGISTRIES_PATH, { ...request, columns: [{ ...request.columns[0], [key]: value }] }, { cookie: owner.sessionCookie });
      expect([key, atColumn.status, code(atColumn)]).toEqual([key, 422, "VALIDATION_FAILED"]);
    }
    for (const body of [null, "x", [], 5, {}, { symbol: 1, displayName: 2, columns: 3 }]) {
      expect((await post(setup.server, REGISTRIES_PATH, body, { cookie: owner.sessionCookie })).status).toBe(422);
    }
    untouched(setup);
  });

  it("a bad definition lists every issue with its path and a stable code, and creates nothing", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const reply = await post(
      setup.server,
      REGISTRIES_PATH,
      {
        symbol: "Ksiazki",
        displayName: "  ",
        columns: [
          { symbol: "id", displayName: "Id", type: "text" },
          { symbol: "a", displayName: "A", type: "text" },
          { symbol: "a", displayName: "A again", type: "number", typeOptions: { decimalPlaces: 9 } },
          { symbol: "b", displayName: "B", type: "blob" },
          { symbol: "c", displayName: "C", type: "date", defaultValue: "2026-02-31" },
        ],
      },
      { cookie: owner.sessionCookie },
    );
    expect([reply.status, code(reply)]).toEqual([422, "VALIDATION_FAILED"]);
    expect(issuesOf(reply)).toEqual({
      issues: [
        { path: "symbol", code: "SYMBOL_PATTERN" },
        { path: "displayName", code: "NAME_EMPTY" },
        { path: "columns.0.symbol", code: "SYMBOL_RESERVED" },
        { path: "columns.2.symbol", code: "SYMBOL_TAKEN" },
        { path: "columns.2.typeOptions", code: "TYPE_OPTIONS_INVALID" },
        { path: "columns.3.type", code: "TYPE_UNKNOWN" },
        { path: "columns.4.defaultValue", code: "DEFAULT_INVALID" },
      ],
    });
    untouched(setup);
  });

  it("symbols that attack SQL are refused and the system tables stay as they were", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const before = query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master ORDER BY name");
    for (const symbol of ['x"; DROP TABLE "user"; --', "x; DROP TABLE user", "x'y", "reg_x`", "książki", "A", "x y"]) {
      const asRegistry = await post(setup.server, REGISTRIES_PATH, { symbol, displayName: "X", columns: [{ symbol: "a", displayName: "A", type: "text" }] }, { cookie: owner.sessionCookie });
      const asColumn = await post(setup.server, REGISTRIES_PATH, { symbol: "ok", displayName: "X", columns: [{ symbol, displayName: "A", type: "text" }] }, { cookie: owner.sessionCookie });
      expect([symbol, asRegistry.status, code(asRegistry)]).toEqual([symbol, 422, "VALIDATION_FAILED"]);
      expect([symbol, asColumn.status, code(asColumn)]).toEqual([symbol, 422, "VALIDATION_FAILED"]);
    }
    expect(query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master ORDER BY name")).toEqual(before);
    expect(query(setup.instance, `SELECT 1 FROM "user"`)).toHaveLength(1);
  });

  it("a taken symbol is 409 REGISTRY_SYMBOL_TAKEN, also the symbol of a deleted registry; a duplicate after the first changes nothing", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    expect((await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie })).status).toBe(201);
    const again = await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie });
    expect([again.status, code(again)]).toEqual([409, "REGISTRY_SYMBOL_TAKEN"]);
    expect(catalog(setup)).toEqual({ registries: 1, columns: 9 });

    execute(setup.instance, `UPDATE registry SET deleted_at = '2026-10-27T12:00:00.000Z'`);
    expect((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie: owner.sessionCookie })).json()).toEqual({ registries: [] });
    const reuse = await post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie });
    expect([reuse.status, code(reuse)]).toEqual([409, "REGISTRY_SYMBOL_TAKEN"]);
    expect(catalog(setup)).toEqual({ registries: 1, columns: 9 });
  });

  it("at most 60 columns and a body within the limit: 61 columns and 300 KiB are 422 and create nothing", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const columns = (count: number) => Array.from({ length: count }, (_, index) => ({ symbol: `c${index}`, displayName: `C${index}`, type: "text" }));
    const tooMany = await post(setup.server, REGISTRIES_PATH, { symbol: "big", displayName: "Big", columns: columns(61) }, { cookie: owner.sessionCookie });
    expect([tooMany.status, code(tooMany)]).toEqual([422, "VALIDATION_FAILED"]);
    expect(issuesOf(tooMany)).toEqual({ issues: [{ path: "columns", code: "LIMIT_COLUMNS" }] });
    const huge = await post(setup.server, REGISTRIES_PATH, { symbol: "big", displayName: "Big", columns: [{ symbol: "a", displayName: "x".repeat(300 * 1024), type: "text" }] }, { cookie: owner.sessionCookie });
    expect([huge.status, code(huge)]).toEqual([422, "VALIDATION_FAILED"]);
    untouched(setup);
    const exactly = await post(setup.server, REGISTRIES_PATH, { symbol: "big", displayName: "Big", columns: columns(60) }, { cookie: owner.sessionCookie });
    expect(exactly.status).toBe(201);
  });

  it("five parallel requests for one symbol: one registry, four 409", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const replies = await Promise.all(Array.from({ length: 5 }, () => post(setup.server, REGISTRIES_PATH, booksRequest(), { cookie: owner.sessionCookie })));
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(replies.filter((reply) => reply.status === 409).every((reply) => code(reply) === "REGISTRY_SYMBOL_TAKEN")).toBe(true);
    expect(catalog(setup)).toEqual({ registries: 1, columns: 9 });
    expect(tables(setup)).toHaveLength(3);
  });
});

describe("D14.3-AC2 in the test process: the limit, an ended session and a failing audit", () => {
  async function signedIn() {
    const h = await createAppHarness();
    const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
    const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
    const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
    const cookie = confirmed.cookie ?? "";
    const batch = (confirmed.json() as { batchId: string }).batchId;
    await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: batch }, { cookie });
    await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie });
    return { h, cookie };
  }
  const small = (symbol: string) => ({ symbol, displayName: symbol, columns: [{ symbol: "a", displayName: "A", type: "text" }] });
  const registriesIn = (h: Awaited<ReturnType<typeof signedIn>>["h"]) => h.rows("SELECT 1 FROM registry").length;
  const physical = (h: Awaited<ReturnType<typeof signedIn>>["h"]) => h.rows("SELECT name FROM sqlite_master WHERE name LIKE 'reg\\_%' ESCAPE '\\'").length;

  it("200 registries are allowed, the 201st is 409 REGISTRY_LIMIT_EXCEEDED, and deleting one frees a place", async () => {
    const { h, cookie } = await signedIn();
    for (let index = 0; index < 200; index += 1) {
      const created = await h.request("POST", REGISTRIES_PATH, small(`r${index}`), { cookie });
      if (created.status !== 201) throw new Error(`registry ${index} was ${created.status}: ${created.text}`);
    }
    const over = await h.request("POST", REGISTRIES_PATH, small("one_too_many"), { cookie });
    expect([over.status, code(over)]).toEqual([409, "REGISTRY_LIMIT_EXCEEDED"]);
    expect(registriesIn(h)).toBe(200);
    const listed = registryListSchema.parse((await h.request("GET", REGISTRIES_PATH, undefined, { cookie })).json());
    expect(listed.registries).toHaveLength(200);
    h.sql(`UPDATE registry SET deleted_at = '2026-10-27T12:00:00.000Z' WHERE symbol = 'r0'`);
    expect((await h.request("POST", REGISTRIES_PATH, small("one_more"), { cookie })).status).toBe(201);
  }, 60_000);

  it("a session that ends between the middleware and the unit creates nothing: 401, no row, no table", async () => {
    const { h, cookie } = await signedIn();
    h.interruptNextWrite(() => h.sql(`DELETE FROM "session"`));
    const reply = await h.request("POST", REGISTRIES_PATH, booksRequest(), { cookie });
    expect([reply.status, code(reply)]).toEqual([401, "AUTH_REQUIRED"]);
    expect([registriesIn(h), physical(h)]).toEqual([0, 0]);
  });

  it("a failing audit gives 503 with no catalog and no table, and the same request works once the audit does", async () => {
    const { h, cookie } = await signedIn();
    h.sql(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN new.action = 'registry.created' BEGIN SELECT RAISE(ABORT, 'audit unavailable: secret-detail'); END;`);
    const failed = await h.request("POST", REGISTRIES_PATH, booksRequest(), { cookie });
    expect([failed.status, code(failed)]).toEqual([503, "AUTH_UNAVAILABLE"]);
    expect(failed.text).not.toContain("secret-detail");
    expect([registriesIn(h), physical(h), h.rows("SELECT 1 FROM registry_column").length]).toEqual([0, 0, 0]);
    expect(h.logLines().join("\n")).not.toContain("secret-detail");
    h.sql("DROP TRIGGER fail_audit");
    const created = await h.request("POST", REGISTRIES_PATH, booksRequest(), { cookie });
    expect(created.status).toBe(201);
    expect(registrySchema.parse(created.json()).symbol).toBe("ksiazki");
    expect([registriesIn(h), physical(h)]).toEqual([1, 1]);
  });

  it("the audit entry names the symbol and the number of columns, not the definition or the values", async () => {
    const { h, cookie } = await signedIn();
    await h.request("POST", REGISTRIES_PATH, { ...booksRequest(), columns: [{ symbol: "tytul", displayName: "Tytuł tajny", type: "text", defaultValue: "wartość-domyślna-tajna" }] }, { cookie });
    const rows = h.rows<{ details: string }>("SELECT details FROM audit_log WHERE action = 'registry.created'");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.details ?? "{}")).toEqual({ symbol: "ksiazki", columns: 1 });
    expect(JSON.stringify(h.rows("SELECT * FROM audit_log"))).not.toMatch(/tajn/);
    expect(h.logLines().join("\n")).not.toMatch(/tajn/);
  });
});

