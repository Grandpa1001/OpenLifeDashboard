// D15.2 — the records of a registry and the idempotency entries, on a real SQLite file (Architektura
// §4.3, §4.6, §5.4). The adapters are the production ones; the use case of D15.3 is stood in for by
// the composition the test writes: the registry from the catalog, then the record, the entry and the
// revision in one unit.
// AC1: the 25 records of F01 go in with their identifiers and times and come back as 10/10/5 in the
//      order of books-v1.expected.json, equal to what was written; data_revision is 25.
// AC2: a failing insert leaves no record and no revision; the entry and the record commit or roll
//      back together; an expired entry does not answer; empty values sort last and the identifier
//      breaks ties; a name of a column outside the catalog never reaches SQL.
import { readFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { validateNewRegistry, DEFAULT_REGISTRY_LIMITS, type RecordPageQuery, type RegistryDraft, type StoredRecord, type StoredRegistry } from "../../../packages/core/dist/modules/registries/public.js";
import { bindIdempotencyStore, bindRecordStore, bindRegistryStore, UnsafeIdentifierError } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { afterEach, describe, expect, it } from "vitest";
import { closeRigs, createIdentityRig, done, type IdentityRig } from "../../support/identity-rig.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(closeRigs);

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean; position: number };
type FixtureRecord = { id: string; revision: number; createdAt: string; updatedAt: string; values: Record<string, unknown> };
type Fixture = { registries: Array<{ id: string; symbol: string; displayName: string; columns: FixtureColumn[]; records: FixtureRecord[] }> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as Fixture;
const expected = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { pageRecordIds: string[][]; pageTitles: string[][] };
const BOOKS = fixture.registries[0]!;
const OWNER = "owner-1";
const NOW = "2026-10-27T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

const unitOf = (rig: IdentityRig) => createUnitOfWork(rig.connection, (tx) => ({ registries: bindRegistryStore(tx), records: bindRecordStore(tx), idempotency: bindIdempotencyStore(tx) }));
const draft = (): RegistryDraft => ({ symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns });

async function booksRig(): Promise<IdentityRig> {
  const rig = await createIdentityRig();
  unitOf(rig).run((ports) => {
    const checked = validateNewRegistry(draft(), { limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: new Set(), activeRegistryCount: 0 });
    if (!checked.ok) throw new Error("the registry of F01 was refused");
    ports.registries.insert({ id: BOOKS.id, ownerId: OWNER, columnIds: BOOKS.columns.map((column) => column.id), definition: checked.value, nowIso: NOW });
    return done(null);
  });
  return rig;
}

const registryOf = (rig: IdentityRig): StoredRegistry => unitOf(rig).read((ports) => ports.registries.find(OWNER, BOOKS.symbol))!;
const recordOf = (source: FixtureRecord): StoredRecord => ({
  id: source.id,
  registryId: BOOKS.id,
  ownerId: OWNER,
  revision: source.revision,
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
  values: source.values as StoredRecord["values"],
});
const fresh = (n: number, patch: Partial<StoredRecord["values"]> = {}, at = NOW): StoredRecord => ({
  id: `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  registryId: BOOKS.id,
  ownerId: OWNER,
  revision: 1,
  createdAt: at,
  updatedAt: at,
  values: { tytul: `Book ${n}`, ...patch },
});

/** What the use case of D15.3 does for each record, in one unit. */
const insertAll = (rig: IdentityRig, records: readonly StoredRecord[]) =>
  unitOf(rig).run((ports) => {
    const registry = ports.registries.find(OWNER, BOOKS.symbol)!;
    for (const record of records) ports.records.insert(registry, record);
    return done(null);
  });
const page = (rig: IdentityRig, query: RecordPageQuery) => {
  const registry = registryOf(rig);
  return unitOf(rig).read((ports) => ports.records.page(registry, query));
};
const findRecord = (rig: IdentityRig, id: string): StoredRecord | null => {
  const registry = registryOf(rig);
  return unitOf(rig).read((ports) => ports.records.find(registry, id));
};
const byCreated = (pageNumber: number, pageSize = 10): RecordPageQuery => ({ sort: { kind: "system", symbol: "created_at" }, direction: "desc", page: pageNumber, pageSize });
const dataRevision = (rig: IdentityRig): number => rig.rows<{ data_revision: number }>("SELECT data_revision FROM registry")[0]!.data_revision;

describe("D15.2-AC1 the 25 records of F01 in the table and back in pages", () => {
  it("each record is written with its identifier and times and read back equal to what was written", async () => {
    const rig = await booksRig();
    const records = BOOKS.records.map(recordOf);
    insertAll(rig, records);

    expect(dataRevision(rig)).toBe(25);
    expect(registryOf(rig).dataRevision).toBe(25);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toHaveLength(25);
    for (const record of records) expect(findRecord(rig, record.id)).toEqual(record);

    // The stored forms: money is an integer of grosze, a boolean is 0 or 1, an empty value is NULL.
    const [row] = rig.rows<Record<string, unknown>>("SELECT typeof(cena) AS cena, typeof(ponowne_czytanie) AS ponowne, typeof(data_ukonczenia) AS ukonczenia, typeof(strony) AS strony, user_id, revision FROM reg_ksiazki WHERE id = '019a0000-0000-7000-8000-0000000003e9'");
    expect(row).toEqual({ cena: "integer", ponowne: "integer", ukonczenia: "null", strony: "real", user_id: OWNER, revision: 1 });
    expect(findRecord(rig, "019a0000-0000-7000-8000-0000000003e9")?.values["cena"]).toBe(1037);
    expect(findRecord(rig, "019a0000-0000-7000-8000-0000000003e9")?.values["ponowne_czytanie"]).toBe(false);
  });

  it("the pages are 10, 10 and 5 in the order of the expected file, the count is 25, and a restart changes nothing", async () => {
    const rig = await booksRig();
    // Written in the order of the file, which is not the order of the list, so the sort is the query's own.
    insertAll(rig, BOOKS.records.map(recordOf));
    const read = () => [1, 2, 3, 4].map((number) => page(rig, byCreated(number)));
    const check = (pages: ReturnType<typeof read>) => {
      expect(pages.map((each) => each.records.map((record) => record.id))).toEqual([...expected.pageRecordIds, []]);
      expect(pages.slice(0, 3).map((each) => each.records.map((record) => record.values["tytul"]))).toEqual(expected.pageTitles);
      expect(pages.map((each) => each.total)).toEqual([25, 25, 25, 25]);
    };
    check(read());
    rig.reopen();
    check(read());
    expect(page(rig, { ...byCreated(1), pageSize: 100 }).records).toHaveLength(25);
    expect(page(rig, { ...byCreated(1), pageSize: 1 }).records.map((record) => record.id)).toEqual([expected.pageRecordIds[0]![0]]);
  });

  it("an empty value sorts last in both directions and the identifier breaks a tie in the direction of the sort", async () => {
    const rig = await booksRig();
    const same = "2026-10-27T12:00:00.000Z";
    insertAll(rig, [fresh(1, { autor: "B" }, same), fresh(2, { autor: "A" }, same), fresh(3, {}, same), fresh(4, { autor: "B" }, same), fresh(5, { autor: null }, same)]);
    const sorted = (symbol: string, direction: "asc" | "desc", kind: "column" | "system" = "column") =>
      page(rig, { sort: kind === "column" ? { kind, symbol } : { kind, symbol: symbol as "id" }, direction, page: 1, pageSize: 10 }).records.map((record) => Number(record.id.slice(-1)));
    expect(sorted("autor", "asc")).toEqual([2, 1, 4, 3, 5]);
    expect(sorted("autor", "desc")).toEqual([4, 1, 2, 5, 3]);
    expect(sorted("created_at", "asc", "system")).toEqual([1, 2, 3, 4, 5]);
    expect(sorted("created_at", "desc", "system")).toEqual([5, 4, 3, 2, 1]);
    expect(sorted("id", "desc", "system")).toEqual([5, 4, 3, 2, 1]);
    expect(page(rig, { sort: { kind: "column", symbol: "tytul" }, direction: "asc", page: 1, pageSize: 2 }).records.map((record) => record.values["tytul"])).toEqual(["Book 1", "Book 2"]);
  });

  it("a record of another owner's registry is neither found nor listed", async () => {
    const rig = await booksRig();
    insertAll(rig, [fresh(1)]);
    const own = registryOf(rig);
    const foreign: StoredRegistry = { ...own, ownerId: "someone-else" };
    unitOf(rig).read((ports) => {
      expect(ports.records.find(foreign, fresh(1).id)).toBeNull();
      expect(ports.records.page(foreign, byCreated(1))).toEqual({ records: [], total: 0 });
      expect(ports.records.find(own, fresh(1).id)).not.toBeNull();
      return null;
    });
  });

  it("a read unit sees one snapshot: the page and the count do not meet a write made between them", async () => {
    const rig = await booksRig();
    insertAll(rig, [fresh(1), fresh(2)]);
    const writer = openDatabase(rig.file, { role: "writer", busyTimeoutMs: 5000 });
    try {
      const seen = unitOf(rig).read((ports) => {
        const registry = ports.registries.find(OWNER, BOOKS.symbol)!;
        const before = ports.records.page(registry, byCreated(1));
        writer.handle.prepare(`INSERT INTO reg_ksiazki (id, user_id, created_at, updated_at, tytul) VALUES ('019a0000-0000-7000-8000-00000000ffff', ?, ?, ?, 'late')`).run(OWNER, NOW, NOW);
        return { before, after: ports.records.page(registry, byCreated(1)) };
      });
      expect(seen.after).toEqual(seen.before);
      expect(page(rig, byCreated(1)).total).toBe(3);
    } finally {
      writer.close();
    }
  });
});

describe("D15.2-AC2 what must not remain, and what never reaches SQL", () => {
  it("a failing insert leaves no record and no change of the revision, also for the records written before it in the unit", async () => {
    const rig = await booksRig();
    // The table keeps the types it can (a STRICT column turns 5 into '5' by itself); the rest is the rules of core.
    const wrong = [fresh(2, { strony: "many" as never }), fresh(2, { cena: 10.5 })];
    for (const bad of wrong) {
      expect(() => insertAll(rig, [fresh(1), bad]), JSON.stringify(bad.values)).toThrow(/cannot store|CHECK/);
      expect(rig.rows("SELECT * FROM reg_ksiazki")).toEqual([]);
      expect(dataRevision(rig)).toBe(0);
    }
    insertAll(rig, [fresh(1), fresh(2)]);
    expect(dataRevision(rig)).toBe(2);
    // The same identifier twice is the primary key's refusal, and the first record stays.
    expect(() => insertAll(rig, [fresh(3), fresh(1)])).toThrow(/UNIQUE|PRIMARY/);
    expect(rig.rows("SELECT id FROM reg_ksiazki")).toHaveLength(2);
    expect(dataRevision(rig)).toBe(2);
  });

  it("a registry that changed or was deleted since it was read takes the insert back, and a deleted one takes none", async () => {
    const rig = await booksRig();
    const stale: StoredRegistry = { ...registryOf(rig), schemaRevision: 2 };
    expect(() => unitOf(rig).run((ports) => done(ports.records.insert(stale, fresh(1))))).toThrow(/changed or was deleted/);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toEqual([]);
    expect(dataRevision(rig)).toBe(0);

    rig.sql(`UPDATE registry SET deleted_at = '${NOW}'`);
    expect(() => insertAll(rig, [fresh(1)])).toThrow(/deleted registry/);
    // Even a stale object of the registry cannot add to a registry that is deleted in the catalog.
    const live: StoredRegistry = { ...registryOf(rig), deletedAt: null };
    expect(() => unitOf(rig).run((ports) => done(ports.records.insert(live, fresh(1))))).toThrow(/changed or was deleted/);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toEqual([]);
  });

  it("a record and its idempotency entry commit together and are taken back together", async () => {
    const rig = await booksRig();
    const entry = (record: StoredRecord) => ({ ownerId: OWNER, operation: "registries.records.create", key: "key-1", requestHash: "a".repeat(64), response: record, createdAt: NOW, expiresAt: new Date(Date.parse(NOW) + DAY_MS).toISOString() });
    const registry = registryOf(rig);
    const create = (record: StoredRecord, fail: boolean) =>
      unitOf(rig).run((ports) => {
        ports.records.insert(registry, record);
        ports.idempotency.put(entry(record));
        if (fail) throw new Error("the answer could not be sent");
        return done(null);
      });
    expect(() => create(fresh(1), true)).toThrow(/could not be sent/);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toEqual([]);
    expect(rig.rows("SELECT * FROM idempotency_entry")).toEqual([]);
    expect(dataRevision(rig)).toBe(0);

    create(fresh(1), false);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toHaveLength(1);
    expect(rig.rows("SELECT owner_id, operation, key, request_hash, created_at, expires_at FROM idempotency_entry")).toEqual([
      { owner_id: OWNER, operation: "registries.records.create", key: "key-1", request_hash: "a".repeat(64), created_at: NOW, expires_at: "2026-10-28T12:00:00.000Z" },
    ]);
    // A failing entry takes the record back: the key cannot be written twice while it lives.
    expect(() => create(fresh(2), false)).toThrow(/UNIQUE|PRIMARY/);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toHaveLength(1);
    expect(dataRevision(rig)).toBe(1);
  });

  it("the entry gives back the answer and the hash, is bound to owner, operation and key, and survives a restart", async () => {
    const rig = await booksRig();
    const response = fresh(1, { autor: "Ł", ponowne_czytanie: true, cena: 1037 });
    unitOf(rig).run((ports) => done(ports.idempotency.put({ ownerId: OWNER, operation: "op", key: "k", requestHash: "b".repeat(64), response, createdAt: NOW, expiresAt: "2026-10-28T12:00:00.000Z" })));
    const find = (owner: string, operation: string, key: string, at = NOW) => unitOf(rig).read((ports) => ports.idempotency.find(owner, operation, key, at));
    expect(find(OWNER, "op", "k")).toEqual({ requestHash: "b".repeat(64), response });
    expect(find("someone-else", "op", "k")).toBeNull();
    expect(find(OWNER, "other-op", "k")).toBeNull();
    expect(find(OWNER, "op", "K")).toBeNull();
    rig.reopen();
    expect(find(OWNER, "op", "k")).toEqual({ requestHash: "b".repeat(64), response });
  });

  it("an expired entry does not answer, its key can be used again and the expired entries of all owners leave with the next write", async () => {
    const rig = await booksRig();
    const put = (key: string, createdAt: string, expiresAt: string, hash = "c") =>
      unitOf(rig).run((ports) => done(ports.idempotency.put({ ownerId: OWNER, operation: "op", key, requestHash: hash.repeat(64), response: fresh(1), createdAt, expiresAt })));
    const find = (key: string, at: string) => unitOf(rig).read((ports) => ports.idempotency.find(OWNER, "op", key, at));
    put("old", "2026-10-26T12:00:00.000Z", "2026-10-27T12:00:00.000Z");
    expect(find("old", "2026-10-27T11:59:59.999Z")).not.toBeNull();
    expect(find("old", "2026-10-27T12:00:00.000Z")).toBeNull();
    expect(find("old", "2026-10-30T00:00:00.000Z")).toBeNull();

    put("old", "2026-10-27T12:00:01.000Z", "2026-10-28T12:00:01.000Z", "d");
    expect(find("old", "2026-10-27T12:00:02.000Z")?.requestHash).toBe("d".repeat(64));
    put("other", "2026-10-27T12:00:02.000Z", "2026-10-28T12:00:02.000Z");
    put("late", "2026-10-29T00:00:00.000Z", "2026-10-30T00:00:00.000Z");
    expect(rig.rows<{ key: string }>("SELECT key FROM idempotency_entry ORDER BY key")).toEqual([{ key: "late" }]);
  });

  it("the table refuses by itself an entry that is not one", async () => {
    const rig = await booksRig();
    const row = (patch: Partial<Record<string, unknown>>) => {
      const values = { owner_id: OWNER, operation: "op", key: "k", request_hash: "a".repeat(64), response: "{}", created_at: NOW, expires_at: "2026-10-28T12:00:00.000Z", ...patch };
      return () => rig.connection.handle.prepare("INSERT INTO idempotency_entry (owner_id, operation, key, request_hash, response, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(...Object.values(values));
    };
    expect(row({ request_hash: "short" })).toThrow(/CHECK/);
    expect(row({ response: "{not json" })).toThrow(/CHECK/);
    expect(row({ key: "" })).toThrow(/CHECK/);
    expect(row({ key: "k".repeat(256) })).toThrow(/CHECK/);
    expect(row({ operation: "" })).toThrow(/CHECK/);
    expect(row({ expires_at: NOW })).toThrow(/CHECK/);
    expect(row({ owner_id: "nobody" })).toThrow(/FOREIGN KEY/);
    row({})();
    expect(row({})).toThrow(/UNIQUE|PRIMARY/);
  });

  it("a name outside the catalog never reaches SQL: not as a sort column, a direction, a page, a table or a key of the values", async () => {
    const rig = await booksRig();
    insertAll(rig, [fresh(1)]);
    const registry = registryOf(rig);
    const before = rig.rows<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name");
    const list = (query: unknown) => () => unitOf(rig).read((ports) => ports.records.page(registry, query as RecordPageQuery));
    const hostile = ['tytul"; DROP TABLE "user"; --', "tytul; DROP TABLE reg_ksiazki", "user_id", "revision", "unknown", "", "TYTUL", "reg_ksiazki.tytul", "tytul) --"];
    for (const symbol of hostile) {
      expect(list({ ...byCreated(1), sort: { kind: "column", symbol } }), JSON.stringify(symbol)).toThrow(/not a column of the registry/);
      expect(list({ ...byCreated(1), sort: { kind: "system", symbol } }), `system ${JSON.stringify(symbol)}`).toThrow(/not a column of the registry/);
    }
    for (const direction of ["ASC; DROP TABLE x", "up", "", null, undefined]) expect(list({ ...byCreated(1), direction }), String(direction)).toThrow(/direction/);
    for (const [pageNumber, pageSize] of [[0, 10], [-1, 10], [1.5, 10], [1, 0], [1, 101], [1, 2.5], [Number.NaN, 10], [1, Number.POSITIVE_INFINITY], ["1", 10]] as const) {
      expect(list({ ...byCreated(1), page: pageNumber, pageSize }), `${String(pageNumber)}/${String(pageSize)}`).toThrow(/out of range/);
    }
    for (const tableName of ["user", 'reg_ksiazki"; DROP TABLE "user"; --', "reg_other", "REG_ksiazki"]) {
      expect(() => unitOf(rig).read((ports) => ports.records.find({ ...registry, tableName }, "x")), tableName).toThrow(UnsafeIdentifierError);
      expect(() => unitOf(rig).run((ports) => done(ports.records.insert({ ...registry, tableName }, fresh(2)))), tableName).toThrow(UnsafeIdentifierError);
    }
    for (const symbol of ["id", "user_id", "revision", "created_at", ...hostile]) {
      expect(() => unitOf(rig).run((ports) => done(ports.records.insert(registry, fresh(2, { [symbol]: "x" } as never)))), JSON.stringify(symbol)).toThrow(/is not a column of the registry/);
    }
    expect(() => unitOf(rig).run((ports) => done(ports.records.insert(registry, { ...fresh(2), ownerId: "someone-else" })))).toThrow(/does not belong/);
    expect(() => unitOf(rig).run((ports) => done(ports.records.insert(registry, { ...fresh(2), registryId: "another" })))).toThrow(/does not belong/);

    expect(rig.rows<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name")).toEqual(before);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toHaveLength(1);
    expect(dataRevision(rig)).toBe(1);
  });

  it("text of the user is a value only: SQL, markup, control characters and long text are stored and read back as they were", async () => {
    const rig = await booksRig();
    const texts = ["'; DROP TABLE reg_ksiazki; --", "<img src=x onerror=alert(1)>", "line\nbreak\u0000nul", "Zażółć gęślą jaźń 📚", "x".repeat(10_000), "?", "\"quoted\""];
    insertAll(rig, texts.map((text, index) => fresh(index + 1, { tytul: text, autor: text })));
    const stored = texts.map((_, index) => findRecord(rig, fresh(index + 1).id)?.values["tytul"]);
    expect(stored).toEqual(texts);
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toHaveLength(texts.length);
    expect(dataRevision(rig)).toBe(texts.length);
  });
});
