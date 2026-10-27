// D14.2 — the catalog of registries and the table of each, on a real SQLite file (Architektura
// §4.2, §4.3, §5.1). The adapters are the production ones; the use case of D14.3 is stood in for by
// the composition the test writes: the rules of core, then the store and the audit in one unit.
// AC1: Książki of F01 become catalog rows and a real table with the right columns, types and
//      indexes, which takes a record of F01 and refuses what its types refuse.
// AC2: a failing CREATE TABLE, CREATE INDEX or audit takes the catalog back too; a symbol that is
//      taken (also by a deleted registry), over the limit or hostile never reaches the DDL; two
//      creations of one symbol give one registry.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_REGISTRY_LIMITS, validateNewRegistry, type NewRegistry, type RegistryDraft, type RegistryLimits } from "../../../packages/core/dist/modules/registries/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindRegistryStore } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { quoteIdentifier, registryDdl, UnsafeIdentifierError } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { initializeDatabase, migrateDatabase, PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { afterEach, describe, expect, it } from "vitest";
import { closeRigs, createIdentityRig, done, type IdentityRig } from "../../support/identity-rig.ts";
import { scratchDir } from "../../support/scratch.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(closeRigs);

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean; position: number };
type Fixture = { registries: Array<{ id: string; symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ id: string; values: Record<string, unknown> }> }> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as Fixture;
const BOOKS = fixture.registries[0]!;
const OWNER = "owner-1";
const NOW = "2026-10-27T12:00:00.000Z";

const booksDraft = (): RegistryDraft => ({ symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns });
const unitOf = (rig: IdentityRig) => createUnitOfWork(rig.connection, (tx) => ({ registries: bindRegistryStore(tx), audit: bindAppendAudit(tx) }));

/** What the use case of D14.3 does, in one unit: the rules, the catalog and table, the audit. */
function create(rig: IdentityRig, draft: RegistryDraft, ids: { registry: string; columns: readonly string[] }, limits: RegistryLimits = DEFAULT_REGISTRY_LIMITS) {
  return unitOf(rig).run((ports) => {
    const checked = validateNewRegistry(draft, { limits, takenRegistrySymbols: ports.registries.takenSymbols(OWNER), activeRegistryCount: ports.registries.activeCount(OWNER) });
    if (!checked.ok) return done({ issues: checked.issues });
    ports.registries.insert({ id: ids.registry, ownerId: OWNER, columnIds: ids.columns, definition: checked.value, nowIso: NOW });
    ports.audit.append({ ownerId: OWNER, action: "registry.created", entityId: ids.registry, at: NOW, requestId: "req-1", details: { symbol: checked.value.symbol } });
    return done({ issues: [] });
  });
}
const booksIds = () => ({ registry: BOOKS.id, columns: BOOKS.columns.map((column) => column.id) });
const masters = (rig: IdentityRig) => rig.rows<{ type: string; name: string }>("SELECT type, name FROM sqlite_master WHERE name LIKE 'reg\\_%' ESCAPE '\\' OR name LIKE 'idx\\_reg\\_%' ESCAPE '\\'");
const catalog = (rig: IdentityRig) => ({ registries: rig.rows("SELECT * FROM registry").length, columns: rig.rows("SELECT * FROM registry_column").length });

describe("D14.2-AC1 the registry of F01 becomes a catalog and a table", () => {
  it("catalog rows, the table with its columns and types, and the indexes of the date columns", async () => {
    const rig = await createIdentityRig();
    const result = create(rig, booksDraft(), booksIds());
    expect(result.ok && result.value.value.issues).toEqual([]);

    expect(rig.rows("SELECT id, user_id, symbol, display_name, table_name, schema_revision, data_revision, created_at, updated_at, deleted_at FROM registry")).toEqual([
      { id: BOOKS.id, user_id: OWNER, symbol: "ksiazki", display_name: "Książki", table_name: "reg_ksiazki", schema_revision: 1, data_revision: 0, created_at: NOW, updated_at: NOW, deleted_at: null },
    ]);
    const stored = unitOf(rig).read((ports) => ports.registries.find(OWNER, "ksiazki"));
    expect(stored?.columns.map((column) => ({ id: column.id, symbol: column.symbol, displayName: column.displayName, type: column.type, typeOptions: column.typeOptions, defaultValue: column.defaultValue, required: column.required, position: column.position }))).toEqual(
      BOOKS.columns.map((column) => ({ id: column.id, symbol: column.symbol, displayName: column.displayName, type: column.type, typeOptions: column.typeOptions, defaultValue: column.defaultValue, required: column.required, position: column.position })),
    );

    const columns = rig.rows<{ name: string; type: string; notnull: number; pk: number }>("PRAGMA table_info(reg_ksiazki)");
    expect(columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      "id:TEXT",
      "user_id:TEXT",
      "created_at:TEXT",
      "updated_at:TEXT",
      "revision:INTEGER",
      "tytul:TEXT",
      "autor:TEXT",
      "strony:REAL",
      "cena:INTEGER",
      "data_ukonczenia:TEXT",
      "rozpoczeto:TEXT",
      "przypomnienie:TEXT",
      "ponowne_czytanie:INTEGER",
      "status:TEXT",
    ]);
    expect(columns.find((column) => column.name === "id")).toMatchObject({ pk: 1, notnull: 1 });
    expect(rig.rows<{ strict: number }>("SELECT strict FROM pragma_table_list WHERE name = 'reg_ksiazki'")[0]?.strict).toBe(1);
    expect(masters(rig).map((entry) => `${entry.type}:${entry.name}`).sort()).toEqual(["index:idx_reg_ksiazki_data_ukonczenia", "index:idx_reg_ksiazki_rozpoczeto", "table:reg_ksiazki"]);
  });

  it("the table is empty, takes the first record of F01 and gives it back; its types refuse what they refuse", async () => {
    const rig = await createIdentityRig();
    create(rig, booksDraft(), booksIds());
    expect(rig.rows("SELECT * FROM reg_ksiazki")).toEqual([]);

    const first = BOOKS.records[0]!;
    const values = { ...first.values, ponowne_czytanie: first.values["ponowne_czytanie"] === true ? 1 : 0 };
    const symbols = Object.keys(values);
    const insert = rig.connection.handle.prepare(`INSERT INTO reg_ksiazki (id, user_id, created_at, updated_at, ${symbols.join(", ")}) VALUES (?, ?, ?, ?, ${symbols.map(() => "?").join(", ")})`);
    insert.run(first.id, OWNER, NOW, NOW, ...Object.values(values));
    const [row] = rig.rows<Record<string, unknown>>("SELECT * FROM reg_ksiazki");
    expect(row).toMatchObject({ id: first.id, user_id: OWNER, revision: 1, tytul: first.values["tytul"], strony: 10, cena: 1037, status: "planowane", ponowne_czytanie: 0 });

    const bad = (patch: Record<string, unknown>) => () => insert.run("019a0000-0000-7000-8000-ffffffffffff", OWNER, NOW, NOW, ...Object.values({ ...values, ...patch }));
    expect(bad({ ponowne_czytanie: 2 })).toThrow(/CHECK/);
    expect(bad({ strony: "many" })).toThrow(/cannot store/);
    expect(bad({ cena: 10.5 })).toThrow(/cannot store/);
    expect(() => rig.connection.handle.prepare(`INSERT INTO reg_ksiazki (id, user_id, created_at, updated_at) VALUES ('x', 'no-such-user', ?, ?)`).run(NOW, NOW)).toThrow(/FOREIGN KEY/);
  });

  it("the store lists, counts and reports the symbols; a restart finds the registry as it was", async () => {
    const rig = await createIdentityRig();
    create(rig, booksDraft(), booksIds());
    const read = () => unitOf(rig).read((ports) => ({ count: ports.registries.activeCount(OWNER), taken: [...ports.registries.takenSymbols(OWNER)], list: ports.registries.list(OWNER).map((registry) => registry.symbol), none: ports.registries.find(OWNER, "nope") }));
    expect(read()).toEqual({ count: 1, taken: ["ksiazki"], list: ["ksiazki"], none: null });
    rig.reopen();
    expect(read()).toEqual({ count: 1, taken: ["ksiazki"], list: ["ksiazki"], none: null });
    expect(rig.rows("SELECT * FROM audit_log WHERE action = 'registry.created'")).toHaveLength(1);
    expect(unitOf(rig).read((ports) => ports.registries.find(OWNER, "ksiazki")?.columns.length)).toBe(9);
  });

  it("a database of the version before upgrades with its owner and data intact, and then holds a registry", async () => {
    const file = path.join(scratchDir("openlife-registry-migration-"), "app.db");
    const connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
    try {
      initializeDatabase(connection, PRODUCT_MIGRATION_PLAN.slice(0, 9), { instanceId: "4f7d2c9e-8a31-4b6e-9d0f-2c5a7e1b3d49", createdAt: NOW });
      connection.handle.prepare(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('owner-1', 'o', 'o@example.test', 1, NULL, ?, ?)`).run(NOW, NOW);
      expect(migrateDatabase(connection, PRODUCT_MIGRATION_PLAN, NOW)).toEqual({ fromSchemaVersion: 9, toSchemaVersion: PRODUCT_MIGRATION_PLAN.length });
      expect(connection.handle.prepare(`SELECT email FROM "user"`).pluck().get()).toBe("o@example.test");
      expect(connection.handle.prepare("SELECT count(*) FROM registry").pluck().get()).toBe(0);
      expect(connection.handle.prepare("SELECT id FROM schema_migration WHERE version = 10").pluck().get()).toBe("0010-registries");
    } finally {
      connection.close();
    }
  });
});

describe("D14.2-AC2 what must not remain, and what never reaches the DDL", () => {
  it("a CREATE TABLE that fails takes the catalog back: no row, no table, no index", async () => {
    const rig = await createIdentityRig();
    rig.sql(`CREATE TABLE reg_ksiazki (stranger TEXT)`);
    expect(() => create(rig, booksDraft(), booksIds())).toThrow(/already exists/);
    expect(catalog(rig)).toEqual({ registries: 0, columns: 0 });
    expect(masters(rig).map((entry) => entry.name)).toEqual(["reg_ksiazki"]);
    expect(rig.rows("PRAGMA table_info(reg_ksiazki)")).toHaveLength(1);
    expect(rig.rows("SELECT * FROM audit_log WHERE action = 'registry.created'")).toHaveLength(0);
  });

  it("a CREATE INDEX that fails (after the table was created) takes the table back too", async () => {
    const rig = await createIdentityRig();
    rig.sql(`CREATE INDEX idx_reg_ksiazki_rozpoczeto ON audit_log (at)`);
    expect(() => create(rig, booksDraft(), booksIds())).toThrow(/already exists/);
    expect(catalog(rig)).toEqual({ registries: 0, columns: 0 });
    expect(masters(rig).map((entry) => entry.name)).toEqual(["idx_reg_ksiazki_rozpoczeto"]);
  });

  it("a failing audit takes the catalog, the table and the indexes back; the same creation works once the audit does", async () => {
    const rig = await createIdentityRig();
    rig.sql(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN new.action = 'registry.created' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect(() => create(rig, booksDraft(), booksIds())).toThrow(/audit unavailable/);
    expect(catalog(rig)).toEqual({ registries: 0, columns: 0 });
    expect(masters(rig)).toEqual([]);
    rig.sql("DROP TRIGGER fail_audit");
    const again = create(rig, booksDraft(), booksIds());
    expect(again.ok && again.value.value.issues).toEqual([]);
    expect(masters(rig)).toHaveLength(3);
  });

  it("a taken symbol is refused before any DDL, a deleted registry's too; the limits count only the live ones", async () => {
    const rig = await createIdentityRig();
    create(rig, booksDraft(), booksIds());
    const second = create(rig, { ...booksDraft(), displayName: "Again" }, { registry: "019a0000-0000-7000-8000-000000000999", columns: BOOKS.columns.map((_, index) => `019a0000-0000-7000-8000-0000000009${String(index).padStart(2, "0")}`) });
    expect(second.ok && second.value.value.issues).toEqual([{ path: "symbol", code: "SYMBOL_TAKEN" }]);
    expect(catalog(rig)).toEqual({ registries: 1, columns: 9 });

    rig.sql(`UPDATE registry SET deleted_at = '${NOW}'`);
    const view = unitOf(rig).read((ports) => ({ active: ports.registries.activeCount(OWNER), taken: ports.registries.takenSymbols(OWNER).has("ksiazki"), list: ports.registries.list(OWNER).length }));
    expect(view).toEqual({ active: 0, taken: true, list: 0 });
    const reuse = create(rig, booksDraft(), { registry: "019a0000-0000-7000-8000-000000000998", columns: BOOKS.columns.map((_, index) => `019a0000-0000-7000-8000-0000000008${String(index).padStart(2, "0")}`) });
    expect(reuse.ok && reuse.value.value.issues).toEqual([{ path: "symbol", code: "SYMBOL_TAKEN" }]);
    // The adapter itself refuses a taken symbol too, whoever asks, without touching the schema.
    expect(() => unitOf(rig).run((ports) => done(ports.registries.insert({ id: "x1", ownerId: OWNER, columnIds: ["c1"], definition: validated("ksiazki"), nowIso: NOW })))).toThrow(/SYMBOL_TAKEN/);
    expect(masters(rig)).toHaveLength(3);

    const limited = create(rig, { symbol: "inny", displayName: "Inny", columns: [{ symbol: "a", displayName: "A", type: "text" }] }, { registry: "r2", columns: ["c2"] }, { ...DEFAULT_REGISTRY_LIMITS, maxRegistries: 0 });
    expect(limited.ok && limited.value.value.issues).toEqual([{ path: "registry", code: "LIMIT_REGISTRIES" }]);
  });

  it("hostile symbols never become an identifier: the DDL builder and the store refuse them, and the schema is untouched", async () => {
    const hostile = ['x"; DROP TABLE "user"; --', "x; DROP TABLE user", "a b", "A", "x'y", "x\ny", "reg_x`", "ksiazki\u0000", "książki", "", "_x", "x_", "a--b", "1x", "x".repeat(41), "x)", "x\\"];
    const rig = await createIdentityRig();
    const before = rig.rows<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name");
    for (const symbol of hostile) {
      expect(() => registryDdl({ symbol, displayName: "X", columns: [{ symbol: "a", displayName: "A", type: "text", typeOptions: {}, defaultValue: null, required: false, position: 0 }] }), JSON.stringify(symbol)).toThrow(UnsafeIdentifierError);
      expect(() => registryDdl({ symbol: "ok", displayName: "X", columns: [{ symbol, displayName: "A", type: "text", typeOptions: {}, defaultValue: null, required: false, position: 0 }] }), `column ${JSON.stringify(symbol)}`).toThrow(UnsafeIdentifierError);
      // Quoting is the last net and also names indexes, so it allows what an identifier of ours can hold.
      if (!/^[a-z][a-z0-9_]*$/.test(symbol) || symbol.length > 100) expect(() => quoteIdentifier(symbol), JSON.stringify(symbol)).toThrow(UnsafeIdentifierError);
      expect(() => unitOf(rig).run((ports) => done(ports.registries.insert({ id: "h1", ownerId: OWNER, columnIds: ["c1"], definition: { symbol, displayName: "X", columns: [{ symbol: "a", displayName: "A", type: "text", typeOptions: {}, defaultValue: null, required: false, position: 0 }] }, nowIso: NOW }))), JSON.stringify(symbol)).toThrow();
    }
    // A column symbol of the engine or a keyword is refused as an identifier of the table too.
    for (const reserved of ["id", "revision", "select", "user_id"]) {
      expect(() => registryDdl({ symbol: "ok", displayName: "X", columns: [{ symbol: reserved, displayName: "A", type: "text", typeOptions: {}, defaultValue: null, required: false, position: 0 }] })).toThrow(UnsafeIdentifierError);
    }
    expect(catalog(rig)).toEqual({ registries: 0, columns: 0 });
    expect(rig.rows<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name")).toEqual(before);
    expect(rig.rows(`SELECT * FROM "user"`)).toHaveLength(1);
  });

  it("the DDL is built from the catalog only: every statement is the same for the same definition and holds no text of the user", () => {
    const definition = validated("ksiazki", BOOKS.columns);
    const first = registryDdl(definition);
    expect(registryDdl(definition)).toEqual(first);
    expect(first.table).toContain(`CREATE TABLE "reg_ksiazki"`);
    expect(first.table).not.toContain("Książki");
    expect(first.table).not.toContain("Tytuł");
    expect(first.indexes).toEqual([
      `CREATE INDEX "idx_reg_ksiazki_data_ukonczenia" ON "reg_ksiazki" ("data_ukonczenia")`,
      `CREATE INDEX "idx_reg_ksiazki_rozpoczeto" ON "reg_ksiazki" ("rozpoczeto")`,
    ]);
  });

  it("the catalog refuses by itself what the rules refuse: a symbol that is not a symbol, a table name that is not reg_ and the symbol, an unknown type", async () => {
    const rig = await createIdentityRig();
    const row = (patch: Record<string, string>) => {
      const values = { id: "r1", user_id: OWNER, symbol: "ok", display_name: "Ok", table_name: "reg_ok", ...patch };
      return () => rig.connection.handle.prepare(`INSERT INTO registry (id, user_id, symbol, display_name, table_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(values.id, values.user_id, values.symbol, values.display_name, values.table_name, NOW, NOW);
    };
    for (const symbol of ["Bad", "a b", "1a", "a__b", "a_", "x".repeat(41), "", 'a"']) expect(row({ symbol, table_name: `reg_${symbol}` }), JSON.stringify(symbol)).toThrow(/CHECK/);
    expect(row({ table_name: "user" })).toThrow(/CHECK/);
    row({})();
    expect(row({ id: "r2" })).toThrow(/UNIQUE/);
    const column = (patch: Record<string, string>) => () =>
      rig.connection.handle.prepare(`INSERT INTO registry_column (id, registry_id, symbol, display_name, type, required, position, created_at) VALUES (?, 'r1', ?, 'C', ?, 0, 0, ?)`).run(patch["id"] ?? "c1", patch["symbol"] ?? "a", patch["type"] ?? "text", NOW);
    expect(column({ type: "blob" })).toThrow(/CHECK/);
    expect(column({ symbol: "A" })).toThrow(/CHECK/);
    column({})();
    expect(column({ id: "c2" })).toThrow(/UNIQUE/);
  });

  it("two creations of one symbol at once give one registry and one table", async () => {
    const rig = await createIdentityRig();
    const attempt = async (tag: string) => create(rig, booksDraft(), { registry: `${tag}-${BOOKS.id}`, columns: BOOKS.columns.map((column) => `${tag}-${column.id}`) });
    const outcomes = await Promise.all(["a1", "a2", "a3"].map(attempt));
    const issues = outcomes.map((outcome) => (outcome.ok ? outcome.value.value.issues : "failed"));
    expect(issues.filter((entry) => Array.isArray(entry) && entry.length === 0)).toHaveLength(1);
    expect(issues.filter((entry) => Array.isArray(entry) && entry[0]?.code === "SYMBOL_TAKEN")).toHaveLength(2);
    expect(catalog(rig)).toEqual({ registries: 1, columns: 9 });
    expect(masters(rig)).toHaveLength(3);
  });
});

/** A definition that passed the rules, for the tests that go around the use case. */
function validated(symbol: string, columns: ReadonlyArray<Record<string, unknown>> = [{ symbol: "a", displayName: "A", type: "text" }]): NewRegistry {
  const result = validateNewRegistry({ symbol, displayName: "X", columns }, { limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: new Set(), activeRegistryCount: 0 });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
