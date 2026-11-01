// D28.1 — adding, renaming and removing a column and changing whether it is required (Scope §5.6,
// S8; Architektura §4.5 p. 3, 6, §5.2), carried out on a plan in one unit of the writer, on a real
// database file through the adapters of the product.
// AC1: on Książki of F01 a required `ocena` with the default 5 fills the 25 records; an optional date
//      column gets its index and fills nothing; the indexed `data_ukonczenia` and `autor` go from the
//      table with their index, stay in the catalog as removed, and `autor` added again is a new
//      column while the old binding still names the removed one; a new name touches the catalog only;
//      `autor` made required fills its empty cells (white space among them) with the replacement; the
//      audit holds no value; the records keep their revisions and times.
// AC2: a failure after each stage of each change leaves everything as it was; a stale, foreign or
//      expired plan writes nothing; a count of filled cells other than the empty ones is taken back;
//      migration 15 keeps the catalog and refuses two active columns of one symbol.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createStructurePlanSigner } from "../../../apps/server/dist/adapters/structure-plan-signer.js";
import { applyColumnChange, canonicalChange, DEFAULT_REGISTRY_LIMITS, STRUCTURE_PLAN_TTL_MS, validateNewRegistry, type StoredRecord, type StoredRegistry, type TableColumns } from "../../../packages/core/dist/modules/registries/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindDictionaryLookup } from "../../../packages/sqlite/dist/adapters/dictionaries/public.js";
import { bindRecordStore, bindRegistryStore, bindTableColumns } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, migrateDatabase, PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import { createUnitOfWork, type TransactionHandle } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { afterEach, describe, expect, it } from "vitest";
import { F01_DICTIONARY_IDS } from "../../support/books-fixture.ts";
import { closeRigs, createIdentityRig, done, type IdentityRig } from "../../support/identity-rig.ts";
import { scratchDir } from "../../support/scratch.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(closeRigs);

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean; position: number };
type FixtureRecord = { id: string; revision: number; createdAt: string; updatedAt: string; values: Record<string, unknown> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ id: string; symbol: string; displayName: string; columns: FixtureColumn[]; records: FixtureRecord[] }> };
const BOOKS = fixture.registries[0]!;
const OWNER = "owner-1";
const NOW = "2026-10-27T12:00:00.000Z";
const signer = createStructurePlanSigner("9a".repeat(32));
const idOf = (symbol: string): string => BOOKS.columns.find((column) => column.symbol === symbol)!.id;
let sequence = 0;
const newId = (): string => `019a0000-0000-7000-8000-${String(0xd00 + ++sequence).padStart(12, "0")}`;

const unitOf = (rig: IdentityRig, wrap: (tx: TransactionHandle) => TransactionHandle = (tx) => tx, columns: (inner: TableColumns) => TableColumns = (inner) => inner) =>
  createUnitOfWork(rig.connection, (raw) => {
    const tx = wrap(raw);
    return { registries: bindRegistryStore(tx), records: bindRecordStore(tx), dictionaryLookup: bindDictionaryLookup(tx), columns: columns(bindTableColumns(tx)), audit: bindAppendAudit(tx) };
  });

async function booksRig(): Promise<IdentityRig> {
  const rig = await createIdentityRig();
  unitOf(rig).run((ports) => {
    const checked = validateNewRegistry({ symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns }, { limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: new Set(), activeRegistryCount: 0, dictionaryIds: F01_DICTIONARY_IDS });
    if (!checked.ok) throw new Error("the registry of F01 was refused");
    ports.registries.insert({ id: BOOKS.id, ownerId: OWNER, columnIds: BOOKS.columns.map((column) => column.id), definition: checked.value, nowIso: NOW });
    const registry = ports.registries.find(OWNER, BOOKS.symbol)!;
    for (const source of BOOKS.records) ports.records.insert(registry, { id: source.id, registryId: BOOKS.id, ownerId: OWNER, revision: source.revision, createdAt: source.createdAt, updatedAt: source.updatedAt, values: source.values as StoredRecord["values"] });
    return done(null);
  });
  rig.connection.handle.exec(`
    INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES ('scr-1', '${OWNER}', 'Test MVP', 'dark', 'blue', '${NOW}', '${NOW}');
    INSERT INTO widget (id, screen_id, position, type, config, layout, state) VALUES ('wdg-1', 'scr-1', 0, 'register-table', '{"v":1,"title":"Moje książki"}', '{"phone":{},"tablet":{},"desktop":{}}', 'ok');
    INSERT INTO binding (widget_id, slot, ordinal, position, path, target) VALUES
      ('wdg-1', 'columns', 0, 0, 'Field.Register.ksiazki.autor', '{"kind":"column","registryId":"${BOOKS.id}","columnId":"${idOf("autor")}"}');
  `);
  return rig;
}

const registryOf = (rig: IdentityRig): StoredRegistry => unitOf(rig).read((ports) => ports.registries.find(OWNER, BOOKS.symbol))!;
const planOf = (registry: StoredRegistry, change: unknown, expiresAtMs = Date.now() + STRUCTURE_PLAN_TTL_MS): string =>
  signer.issue({ registryId: registry.id, schemaRevision: registry.schemaRevision, dataRevision: registry.dataRevision, expiresAtMs }, { ownerId: OWNER, change: canonicalChange(change) });
const apply = (rig: IdentityRig, change: unknown, planToken = planOf(registryOf(rig), change), unit = unitOf(rig), nowMs = Date.now()) =>
  unit.run((ports) => applyColumnChange(ports, { signer, limits: DEFAULT_REGISTRY_LIMITS, nowMs, newId }, { ownerId: OWNER, symbol: BOOKS.symbol, change, planToken, requestId: "req-d28-1" }));
const tableColumns = (rig: IdentityRig): string[] => rig.rows<{ name: string }>("SELECT name FROM pragma_table_info('reg_ksiazki') ORDER BY cid").map((row) => row.name);
const indexes = (rig: IdentityRig): string[] => rig.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reg_ksiazki' AND sql IS NOT NULL ORDER BY name").map((row) => row.name);
const engine = (rig: IdentityRig) => rig.rows("SELECT id, user_id, created_at, updated_at, revision FROM reg_ksiazki ORDER BY id");
const audits = (rig: IdentityRig) => rig.rows<{ action: string; details: string }>("SELECT action, details FROM audit_log WHERE action LIKE 'registry.%' ORDER BY rowid").map((row) => [row.action, JSON.parse(row.details) as unknown]);

function state(rig: IdentityRig): string {
  const tables = ["registry", "registry_column", "screen", "widget", "binding", "audit_log", "reg_ksiazki"];
  return JSON.stringify({ schema: rig.rows("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"), rows: tables.map((table) => rig.rows(`SELECT * FROM "${table}" ORDER BY 1`)) });
}

const ADD_REQUIRED = { kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", defaultValue: 5, required: true } };
const ADD_DATE = { kind: "addColumn", column: { symbol: "przeczytano", displayName: "Przeczytano", type: "date" } };
const REMOVE_DATE = { kind: "removeColumn", columnId: idOf("data_ukonczenia") };
const REMOVE_AUTHOR = { kind: "removeColumn", columnId: idOf("autor") };
const RENAME = { kind: "renameColumn", columnId: idOf("strony"), displayName: "Liczba stron książki" };
const REQUIRE_AUTHOR = { kind: "setRequired", columnId: idOf("autor"), required: true, replacement: "Nieznany" };

describe("D28.1-AC1 the columns of F01 change on their plans", () => {
  it("a required column with a default fills the 25 records; an optional date column gets its index and fills nothing", async () => {
    const rig = await booksRig();
    const rows = engine(rig);
    expect(apply(rig, ADD_REQUIRED)).toMatchObject({ ok: true, value: { value: { schemaRevision: 2, affected: 25 }, invalidations: [{ resource: "schema", resourceId: BOOKS.id }] } });
    expect(rig.rows("SELECT DISTINCT ocena FROM reg_ksiazki")).toEqual([{ ocena: 5 }]);
    expect(registryOf(rig).columns.find((column) => column.symbol === "ocena")).toMatchObject({ type: "number", required: true, defaultValue: 5, position: BOOKS.columns.length });

    expect(apply(rig, ADD_DATE)).toMatchObject({ ok: true, value: { value: { schemaRevision: 3, affected: 0 } } });
    expect(rig.rows("SELECT count(*) AS n FROM reg_ksiazki WHERE przeczytano IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(indexes(rig)).toContain("idx_reg_ksiazki_przeczytano");
    expect(engine(rig)).toEqual(rows);
    expect(audits(rig)).toEqual([
      ["registry.column_added", { registry: "ksiazki", column: "ocena", type: "number", required: true, filled: 25 }],
      ["registry.column_added", { registry: "ksiazki", column: "przeczytano", type: "date", required: false, filled: 0 }],
    ]);
  });

  it("the indexed data_ukonczenia and autor leave the table, stay removed in the catalog; autor added again is a new column and the old binding names the removed one", async () => {
    const rig = await booksRig();
    const binding = rig.rows("SELECT * FROM binding");
    expect(indexes(rig)).toContain("idx_reg_ksiazki_data_ukonczenia");
    expect(apply(rig, REMOVE_DATE)).toMatchObject({ ok: true, value: { value: { schemaRevision: 2, columnId: idOf("data_ukonczenia") } } });
    expect(apply(rig, REMOVE_AUTHOR)).toMatchObject({ ok: true, value: { value: { schemaRevision: 3 } } });
    expect(tableColumns(rig)).not.toContain("data_ukonczenia");
    expect(tableColumns(rig)).not.toContain("autor");
    expect(indexes(rig)).not.toContain("idx_reg_ksiazki_data_ukonczenia");
    expect(registryOf(rig).columns.map((column) => column.symbol)).not.toContain("autor");
    expect(rig.rows("SELECT symbol, deleted_at IS NOT NULL AS removed FROM registry_column WHERE symbol IN ('autor', 'data_ukonczenia') ORDER BY symbol")).toEqual([{ symbol: "autor", removed: 1 }, { symbol: "data_ukonczenia", removed: 1 }]);

    const again = apply(rig, { kind: "addColumn", column: { symbol: "autor", displayName: "Autor", type: "text" } });
    expect(again).toMatchObject({ ok: true, value: { value: { schemaRevision: 4 } } });
    const added = again.ok ? again.value.value.columnId : "";
    expect(added).not.toBe(idOf("autor"));
    expect(rig.rows("SELECT id, deleted_at IS NOT NULL AS removed FROM registry_column WHERE symbol = 'autor' ORDER BY removed")).toEqual([{ id: added, removed: 0 }, { id: idOf("autor"), removed: 1 }]);
    expect(rig.rows("SELECT count(*) AS n FROM reg_ksiazki WHERE autor IS NOT NULL")).toEqual([{ n: 0 }]);
    expect(rig.rows("SELECT * FROM binding")).toEqual(binding);
    expect(rig.rows("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("a new name touches the catalog only; autor made required fills its empty cells, white space among them, with the replacement", async () => {
    const rig = await booksRig();
    const table = rig.rows("SELECT sql FROM sqlite_master WHERE name = 'reg_ksiazki'");
    expect(apply(rig, RENAME)).toMatchObject({ ok: true, value: { value: { schemaRevision: 2, affected: 0 } } });
    expect(registryOf(rig).columns.find((column) => column.symbol === "strony")?.displayName).toBe("Liczba stron książki");
    expect(rig.rows("SELECT sql FROM sqlite_master WHERE name = 'reg_ksiazki'")).toEqual(table);

    rig.connection.handle.prepare("UPDATE reg_ksiazki SET autor = '   ' WHERE id = ?").run(BOOKS.records.find((record) => record.values["autor"] !== null)!.id);
    const empty = rig.rows<{ n: number }>("SELECT count(*) AS n FROM reg_ksiazki WHERE autor IS NULL OR trim(autor) = ''")[0]!.n;
    expect(empty).toBe(4);
    const rows = engine(rig);
    expect(apply(rig, REQUIRE_AUTHOR)).toMatchObject({ ok: true, value: { value: { schemaRevision: 3, affected: 4 } } });
    expect(rig.rows("SELECT count(*) AS n FROM reg_ksiazki WHERE autor = 'Nieznany'")).toEqual([{ n: 4 }]);
    expect(registryOf(rig).columns.find((column) => column.symbol === "autor")?.required).toBe(true);
    expect(engine(rig)).toEqual(rows);
    expect(audits(rig)).toEqual([
      ["registry.column_renamed", { registry: "ksiazki", column: "strony" }],
      ["registry.column_required_changed", { registry: "ksiazki", column: "autor", required: true, filled: 4 }],
    ]);
  });
});

/** A handle whose statements matching `stage` throw after they ran `afterRuns` times. */
function failingAfter(stage: RegExp, afterRuns = 1): (tx: TransactionHandle) => TransactionHandle {
  let runs = 0;
  return (tx) => ({
    prepare(sql: string) {
      const statement = tx.prepare(sql);
      if (!stage.test(sql)) return statement;
      const after = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => {
        const result = call(...args);
        runs += 1;
        if (runs >= afterRuns) throw new Error(`a failure injected after: ${sql.slice(0, 40)}`);
        return result;
      };
      return { run: after(statement.run), get: after(statement.get), all: after(statement.all), iterate: statement.iterate };
    },
  });
}

describe("D28.1-AC2 nothing of a column change that fails stays, and a plan that is not current changes nothing", () => {
  const CATALOG = [/^UPDATE registry SET schema_revision/, /^INSERT INTO audit_log/];
  const CASES: ReadonlyArray<[string, unknown, readonly RegExp[], number?]> = [
    ["adding a required column", ADD_REQUIRED, [/^ALTER TABLE "reg_ksiazki" ADD COLUMN/, /^UPDATE "reg_ksiazki" SET "ocena"/, /^\s*INSERT INTO registry_column/, ...CATALOG]],
    ["adding a date column", ADD_DATE, [/^ALTER TABLE "reg_ksiazki" ADD COLUMN/, /^CREATE INDEX/, /^\s*INSERT INTO registry_column/, ...CATALOG]],
    ["removing an indexed column", REMOVE_DATE, [/^DROP INDEX/, /^ALTER TABLE "reg_ksiazki" DROP COLUMN/, /^UPDATE registry_column SET deleted_at/, ...CATALOG]],
    ["renaming a column", RENAME, [/^UPDATE registry_column SET display_name/, ...CATALOG]],
    ["making a column required", REQUIRE_AUTHOR, [/^UPDATE "reg_ksiazki" SET "autor"/, /^UPDATE registry_column SET type/, ...CATALOG]],
  ];
  for (const [name, change, stages] of CASES) {
    it(`${name}: a failure after each of its ${stages.length} stages leaves everything as it was`, async () => {
      const rig = await booksRig();
      const before = state(rig);
      const plan = planOf(registryOf(rig), change);
      for (const stage of stages) {
        expect(() => apply(rig, change, plan, unitOf(rig, failingAfter(stage))), String(stage)).toThrow(/a failure injected after/);
        expect(state(rig), String(stage)).toBe(before);
      }
      expect(apply(rig, change, plan)).toMatchObject({ ok: true });
    });
  }

  it("a stale, foreign or expired plan writes nothing; filled cells other than the empty ones are taken back", async () => {
    const rig = await booksRig();
    const before = state(rig);
    const plan = planOf(registryOf(rig), REMOVE_AUTHOR);
    expect(apply(rig, REMOVE_DATE, plan)).toEqual({ ok: false, error: { code: "PLAN_INVALID" } });
    expect(apply(rig, REMOVE_AUTHOR, plan, unitOf(rig), Date.now() + STRUCTURE_PLAN_TTL_MS)).toEqual({ ok: false, error: { code: "PLAN_EXPIRED" } });
    const foreign = signer.issue({ registryId: BOOKS.id, schemaRevision: 1, dataRevision: 25, expiresAtMs: Date.now() + 60_000 }, { ownerId: "someone-else", change: canonicalChange(REMOVE_AUTHOR) });
    expect(apply(rig, REMOVE_AUTHOR, foreign)).toEqual({ ok: false, error: { code: "PLAN_INVALID" } });
    const miscounting = (inner: TableColumns): TableColumns => ({ ...inner, fillEmpty: (...args) => inner.fillEmpty(...args) - 1 });
    expect(() => apply(rig, REQUIRE_AUTHOR, planOf(registryOf(rig), REQUIRE_AUTHOR), unitOf(rig, undefined, miscounting))).toThrow(/other cells than were empty/);
    expect(state(rig)).toBe(before);

    expect(apply(rig, RENAME)).toMatchObject({ ok: true });
    expect(apply(rig, REMOVE_AUTHOR, plan)).toEqual({ ok: false, error: { code: "PLAN_STALE" } });
  });

  it("migration 15 keeps the catalog of a database at version 14 and refuses two active columns of one symbol", async () => {
    const file = path.join(scratchDir("openlife-d28-migration-"), "app.db");
    const connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
    try {
      initializeDatabase(connection, PRODUCT_MIGRATION_PLAN.slice(0, 14), { instanceId: "4f7d2c9e-8a31-4b6e-9d0f-2c5a7e1b3d48", createdAt: NOW });
      // The owner and the catalog rows of F01 as version 14 holds them.
      connection.handle.prepare('INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)').run(OWNER, "Owner", "owner@example.test", NOW, NOW);
      connection.handle.prepare("INSERT INTO registry (id, user_id, symbol, display_name, table_name, schema_revision, data_revision, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, NULL)").run(BOOKS.id, OWNER, BOOKS.symbol, BOOKS.displayName, "reg_ksiazki", NOW, NOW);
      const insert = connection.handle.prepare("INSERT INTO registry_column (id, registry_id, symbol, display_name, type, type_options, default_value, required, position, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const column of BOOKS.columns) insert.run(column.id, BOOKS.id, column.symbol, column.displayName, column.type, JSON.stringify(column.typeOptions ?? {}), column.defaultValue === null ? null : JSON.stringify(column.defaultValue), column.required ? 1 : 0, column.position, NOW, column.symbol === "autor" ? NOW : null);
      const before = connection.handle.prepare("SELECT * FROM registry_column ORDER BY id").all();
      // Version 14 refuses a removed column's symbol again.
      expect(() => insert.run("019a0000-0000-7000-8000-0000000003e7", BOOKS.id, "autor", "Autor", "text", "{}", null, 0, 9, NOW, null)).toThrow(/UNIQUE/);

      migrateDatabase(connection, PRODUCT_MIGRATION_PLAN, NOW);
      expect(connection.handle.prepare("SELECT * FROM registry_column ORDER BY id").all()).toEqual(before);
      const insertAfter = connection.handle.prepare("INSERT INTO registry_column (id, registry_id, symbol, display_name, type, type_options, default_value, required, position, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      insertAfter.run("019a0000-0000-7000-8000-0000000003e7", BOOKS.id, "autor", "Autor", "text", "{}", null, 0, 9, NOW, null);
      expect(() => insertAfter.run("019a0000-0000-7000-8000-0000000003e8", BOOKS.id, "autor", "Autor", "text", "{}", null, 0, 10, NOW, null)).toThrow(/UNIQUE/);
      expect(connection.handle.prepare("PRAGMA foreign_key_check(registry_column)").all()).toEqual([]);
    } finally {
      connection.close();
    }
  });
});
