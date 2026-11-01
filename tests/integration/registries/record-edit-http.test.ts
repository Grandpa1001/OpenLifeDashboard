// D23.1 — changing, deleting and reading one record over real HTTP on the built server (Architektura
// §4.6, §6, §7.6, §18.2), on Książki of F01. A change and a delete name the revision they were built
// on, so two forms of the same revision cannot both win, and a repeat after a lost answer is a
// conflict or a missing record, never a second effect.
// AC1: two changes of revision 1: one is 200 with revision 2, the other 409 RECORD_CONFLICT and
//      writes nothing; a column the change leaves out stays; data_revision rises by one per change
//      and per delete; a restart reads the same.
// AC2: a stale schema, an unknown and a system field, an empty change and a required column set to
//      null are refused with their codes; a foreign or unknown record is 404; a delete on a stale
//      revision keeps the record and a repeated delete is 404; a foreign Origin is refused; a POST
//      repeated after a lost answer still adds one record (D15).
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, recordSchema, registryRecordPath, registryRecordsPath, type RecordDto } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { installation, post, query, readyOwner, send, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";
import { withoutDictionary } from "../../support/books-fixture.ts";

afterEach(stopServers);

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ values: Record<string, unknown> }> }> };
const BOOKS = fixture.registries[0]!;
const RECORDS = registryRecordsPath(BOOKS.symbol);
const one = (id: string) => registryRecordPath(BOOKS.symbol, id);
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const issues = (reply: { json: () => unknown }): unknown => apiErrorSchema.parse(reply.json()).details?.["issues"];

const stored = (setup: Installation) => ({
  rows: query(setup.instance, `SELECT * FROM reg_${BOOKS.symbol} ORDER BY id`),
  dataRevision: query<{ data_revision: number }>(setup.instance, "SELECT data_revision FROM registry")[0]?.data_revision ?? null,
});

/** Książki of F01 with its first two records, each added through the API. */
async function books(setup: Installation): Promise<{ cookie: string; records: RecordDto[] }> {
  const owner = await readyOwner(setup);
  const cookie = owner.sessionCookie;
  const definition = { symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })) };
  expect((await post(setup.server, REGISTRIES_PATH, definition, { cookie })).status).toBe(201);
  const records: RecordDto[] = [];
  for (const [index, record] of BOOKS.records.slice(0, 2).entries()) {
    const added = await post(setup.server, RECORDS, { schemaRevision: 1, values: record.values }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `d23-1-add-${index}` } });
    expect(added.status).toBe(201);
    records.push(recordSchema.parse(added.json()));
  }
  return { cookie, records };
}

describe("D23.1-AC1 two changes of the same revision", () => {
  it("one wins with revision 2, the other is a conflict and writes nothing; the untouched columns stay; a delete raises the data revision; a restart reads the same", async () => {
    const setup = await installation();
    const { cookie, records } = await books(setup);
    const target = records[0]!;
    expect(stored(setup).dataRevision).toBe(2);

    // Two forms opened on revision 1, each changing another column.
    const first = await send(setup.server, "PATCH", one(target.id), { schemaRevision: 1, expectedRevision: 1, values: { strony: 12 } }, { cookie });
    expect(first.status).toBe(200);
    const changed = recordSchema.parse(first.json());
    expect(changed).toMatchObject({ id: target.id, revision: 2, createdAt: target.createdAt, values: { ...target.values, strony: 12 } });
    expect(Date.parse(changed.updatedAt)).toBeGreaterThanOrEqual(Date.parse(target.updatedAt));
    expect(stored(setup).dataRevision).toBe(3);

    const before = stored(setup);
    const second = await send(setup.server, "PATCH", one(target.id), { schemaRevision: 1, expectedRevision: 1, values: { autor: "Inny autor" } }, { cookie });
    expect([second.status, code(second)]).toEqual([409, "RECORD_CONFLICT"]);
    // The conflict carries no values of the record (Architektura §7.6).
    expect(apiErrorSchema.parse(second.json()).details).toBeNull();
    expect(stored(setup)).toEqual(before);

    // The second form reads the record anew and changes it on revision 2: the change of the first stays.
    const current = recordSchema.parse((await send(setup.server, "GET", one(target.id), undefined, { cookie })).json());
    expect(current).toEqual(changed);
    const third = await send(setup.server, "PATCH", one(target.id), { schemaRevision: 1, expectedRevision: current.revision, values: { autor: "Inny autor" } }, { cookie });
    expect(third.status).toBe(200);
    expect(recordSchema.parse(third.json())).toMatchObject({ revision: 3, values: { ...target.values, strony: 12, autor: "Inny autor" } });
    expect(stored(setup).dataRevision).toBe(4);

    // A delete of the other record on its revision: 204, one record fewer, the data revision once more.
    const removed = await send(setup.server, "DELETE", one(records[1]!.id), { expectedRevision: 1 }, { cookie });
    expect([removed.status, removed.text]).toEqual([204, ""]);
    expect(stored(setup).rows).toHaveLength(1);
    expect(stored(setup).dataRevision).toBe(5);
    const page = (await send(setup.server, "GET", RECORDS, undefined, { cookie })).json() as { total: number; dataRevision: number };
    expect(page).toMatchObject({ total: 1, dataRevision: 5 });

    const after = stored(setup);
    await stopServer(setup.server);
    const again = await serve(setup.instance);
    expect(recordSchema.parse((await send(again, "GET", one(target.id), undefined, { cookie })).json())).toMatchObject({ revision: 3, values: { strony: 12, autor: "Inny autor" } });
    expect(stored(setup)).toEqual(after);
  });
});

describe("D23.1-AC2 what a change and a delete refuse", () => {
  it("a stale schema, foreign fields, an empty change and a required column set to null are refused with their codes and write nothing", async () => {
    const setup = await installation();
    const { cookie, records } = await books(setup);
    const id = records[0]!.id;
    const before = stored(setup);
    const patch = (body: unknown) => send(setup.server, "PATCH", one(id), body, { cookie });

    const stale = await patch({ schemaRevision: 2, expectedRevision: 1, values: { strony: 1 } });
    expect([stale.status, code(stale)]).toEqual([409, "SCHEMA_CHANGED"]);
    // The schema is checked before the revision: a form on another schema reloads the definition first.
    const both = await patch({ schemaRevision: 0, expectedRevision: 7, values: { strony: 1 } });
    expect([both.status, code(both)]).toEqual([409, "SCHEMA_CHANGED"]);

    const foreign = await patch({ schemaRevision: 1, expectedRevision: 1, values: { revision: 9, user_id: "someone-else", kolor: "x" } });
    expect([foreign.status, code(foreign)]).toEqual([422, "VALIDATION_FAILED"]);
    expect(issues(foreign)).toEqual([
      { path: "values.revision", code: "FIELD_SYSTEM" },
      { path: "values.user_id", code: "FIELD_SYSTEM" },
      { path: "values.kolor", code: "FIELD_UNKNOWN" },
    ]);
    const empty = await patch({ schemaRevision: 1, expectedRevision: 1, values: {} });
    expect([empty.status, issues(empty)]).toEqual([422, [{ path: "values", code: "VALUES_EMPTY" }]]);
    const required = await patch({ schemaRevision: 1, expectedRevision: 1, values: { tytul: null, cena: 10.5 } });
    expect([required.status, issues(required)]).toEqual([422, [{ path: "values.tytul", code: "VALUE_REQUIRED" }, { path: "values.cena", code: "VALUE_INVALID" }]]);
    // The shape: no revision, a revision 0, an owner in the body, a body that is not JSON.
    for (const body of [{ schemaRevision: 1, values: { strony: 1 } }, { schemaRevision: 1, expectedRevision: 0, values: { strony: 1 } }, { schemaRevision: 1, expectedRevision: 1, values: { strony: 1 }, ownerId: "x" }, "{"]) {
      const reply = await patch(body);
      expect([reply.status, code(reply)], JSON.stringify(body)).toEqual([422, "VALIDATION_FAILED"]);
    }
    const origin = await send(setup.server, "PATCH", one(id), { schemaRevision: 1, expectedRevision: 1, values: { strony: 1 } }, { cookie, origin: "https://evil.example" });
    expect([origin.status, code(origin)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    const originDelete = await send(setup.server, "DELETE", one(id), { expectedRevision: 1 }, { cookie, origin: "https://evil.example" });
    expect([originDelete.status, code(originDelete)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    expect(stored(setup)).toEqual(before);
  });

  it("an unknown record, a record of another installation and an unknown registry are 404 for a read, a change and a delete", async () => {
    const setup = await installation();
    const { cookie } = await books(setup);
    const other = await installation();
    const elsewhere = await books(other);
    const before = stored(setup);
    const targets = [one("019a0000-0000-7000-8000-00000000ffff"), one(elsewhere.records[0]!.id), registryRecordPath("nieznany", elsewhere.records[0]!.id), one("not-an-identifier")];
    for (const target of targets) {
      for (const [method, body] of [["GET", undefined], ["PATCH", { schemaRevision: 1, expectedRevision: 1, values: { strony: 1 } }], ["DELETE", { expectedRevision: 1 }]] as const) {
        const reply = await send(setup.server, method, target, body, { cookie });
        expect([reply.status, code(reply)], `${method} ${target}`).toEqual([404, "NOT_FOUND"]);
      }
    }
    expect(stored(setup)).toEqual(before);
    expect(stored(other).rows).toHaveLength(2);
  });

  it("a delete on a stale revision keeps the record; a repeated delete is 404 and removes nothing more", async () => {
    const setup = await installation();
    const { cookie, records } = await books(setup);
    const [target, kept] = [records[0]!, records[1]!];
    expect((await send(setup.server, "PATCH", one(target.id), { schemaRevision: 1, expectedRevision: 1, values: { strony: 3 } }, { cookie })).status).toBe(200);

    const before = stored(setup);
    const stale = await send(setup.server, "DELETE", one(target.id), { expectedRevision: 1 }, { cookie });
    expect([stale.status, code(stale)]).toEqual([409, "RECORD_CONFLICT"]);
    expect(stored(setup)).toEqual(before);

    expect((await send(setup.server, "DELETE", one(target.id), { expectedRevision: 2 }, { cookie })).status).toBe(204);
    const afterDelete = stored(setup);
    const repeated = await send(setup.server, "DELETE", one(target.id), { expectedRevision: 2 }, { cookie });
    expect([repeated.status, code(repeated)]).toEqual([404, "NOT_FOUND"]);
    // A change after the delete, as a form left open would send it, finds nothing.
    const late = await send(setup.server, "PATCH", one(target.id), { schemaRevision: 1, expectedRevision: 2, values: { strony: 4 } }, { cookie });
    expect([late.status, code(late)]).toEqual([404, "NOT_FOUND"]);
    expect(stored(setup)).toEqual(afterDelete);
    expect(afterDelete.rows.map((row) => (row as { id: string }).id)).toEqual([kept.id]);
  });

  it("a change repeated after a lost answer is a conflict and changes nothing more; an add repeated with its key is still one record (D15)", async () => {
    const setup = await installation();
    const { cookie, records } = await books(setup);
    const body = { schemaRevision: 1, expectedRevision: 1, values: { strony: 21 } };
    expect((await send(setup.server, "PATCH", one(records[0]!.id), body, { cookie })).status).toBe(200);
    const once = stored(setup);
    const repeat = await send(setup.server, "PATCH", one(records[0]!.id), body, { cookie });
    expect([repeat.status, code(repeat)]).toEqual([409, "RECORD_CONFLICT"]);
    expect(stored(setup)).toEqual(once);

    const add = { schemaRevision: 1, values: BOOKS.records[2]!.values };
    const headers = { [IDEMPOTENCY_KEY_HEADER]: "d23-1-lost-answer" };
    expect((await post(setup.server, RECORDS, add, { cookie, headers })).status).toBe(201);
    const replay = await post(setup.server, RECORDS, add, { cookie, headers });
    expect(replay.status).toBe(200);
    expect(stored(setup).rows).toHaveLength(3);
  });
});
