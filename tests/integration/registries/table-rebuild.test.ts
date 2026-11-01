// D27.1 — the PoC of the rebuild of a registry's table for a change of a column's type (Architektura
// §4.5 p. 3, 5–7, §4.6, §5.2; S9), on a real database file through the adapters of the product.
// AC1: Książki of F01 `strony` number → text keeps the 25 rows with their identifiers, owner, times
//      and revisions, stores "10"…, has the DDL of the new definition and its indexes, raises the
//      schema revision, audits without values and leaves the bindings; S9 text → number converts 12,
//      empties abc and counts it, and a required column takes the replacement.
// AC2: a failure after each stage (and a conversion that throws half-way through the copy) leaves the
//      catalog, the table, the bindings and the audit exactly as they were, without the new table; a
//      stale, foreign or expired plan changes nothing; a count of failures other than the report's is
//      taken back; 50 000 records are rebuilt and measured.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createStructurePlanSigner } from "../../../apps/server/dist/adapters/structure-plan-signer.js";
import { canonicalChange, changeColumnType, DEFAULT_REGISTRY_LIMITS, STRUCTURE_PLAN_TTL_MS, validateNewRegistry, type RegistryDraft, type StoredRecord, type StoredRegistry, type TableRebuild } from "../../../packages/core/dist/modules/registries/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindDictionaryLookup } from "../../../packages/sqlite/dist/adapters/dictionaries/public.js";
import { bindRecordStore, bindRegistryStore, bindTableRebuild, registryDdl } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { bindOwnerPreferencesStore } from "../../../packages/sqlite/dist/adapters/settings/owner-preferences.js";
import { createUnitOfWork, type TransactionHandle } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { afterEach, describe, expect, it } from "vitest";
import { F01_DICTIONARY_IDS } from "../../support/books-fixture.ts";
import { closeRigs, createIdentityRig, done, type IdentityRig } from "../../support/identity-rig.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(closeRigs);

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean; position: number };
type FixtureRecord = { id: string; revision: number; createdAt: string; updatedAt: string; values: Record<string, unknown> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ id: string; symbol: string; displayName: string; columns: FixtureColumn[]; records: FixtureRecord[] }> };
const BOOKS = fixture.registries[0]!;
const OWNER = "owner-1";
const NOW = "2026-10-27T12:00:00.000Z";
const signer = createStructurePlanSigner("cd".repeat(32));

/** The ports of the work of a rebuild, on a handle the test may wrap to fail after a stage. */
const unitOf = (rig: IdentityRig, wrap: (tx: TransactionHandle) => TransactionHandle = (tx) => tx, rebuild: (inner: TableRebuild) => TableRebuild = (inner) => inner) =>
  createUnitOfWork(rig.connection, (raw) => {
    const tx = wrap(raw);
    return {
      registries: bindRegistryStore(tx),
      records: bindRecordStore(tx),
      dictionaryLookup: bindDictionaryLookup(tx),
      preferences: bindOwnerPreferencesStore(tx),
      rebuild: rebuild(bindTableRebuild(tx)),
      audit: bindAppendAudit(tx),
    };
  });

function registryRig(rig: IdentityRig, draft: RegistryDraft, id: string, columnIds: readonly string[], records: readonly StoredRecord[]): void {
  unitOf(rig).run((ports) => {
    const checked = validateNewRegistry(draft, { limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: new Set(), activeRegistryCount: 0, dictionaryIds: F01_DICTIONARY_IDS });
    if (!checked.ok) throw new Error("a registry of the test was refused");
    ports.registries.insert({ id, ownerId: OWNER, columnIds, definition: checked.value, nowIso: NOW });
    const registry = ports.registries.find(OWNER, checked.value.symbol)!;
    for (const record of records) ports.records.insert(registry, record);
    return done(null);
  });
}

async function booksRig(): Promise<IdentityRig> {
  const rig = await createIdentityRig();
  const records = BOOKS.records.map((source): StoredRecord => ({ id: source.id, registryId: BOOKS.id, ownerId: OWNER, revision: source.revision, createdAt: source.createdAt, updatedAt: source.updatedAt, values: source.values as StoredRecord["values"] }));
  registryRig(rig, { symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns }, BOOKS.id, BOOKS.columns.map((column) => column.id), records);
  // A screen with the table widget of F01, bound to the registry and two of its columns by identifier.
  rig.connection.handle.exec(`
    INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES ('scr-1', '${OWNER}', 'Test MVP', 'dark', 'blue', '${NOW}', '${NOW}');
    INSERT INTO widget (id, screen_id, position, type, config, layout, state) VALUES ('wdg-1', 'scr-1', 0, 'register-table', '{"v":1,"title":"Moje książki"}', '{"phone":{},"tablet":{},"desktop":{}}', 'ok');
    INSERT INTO binding (widget_id, slot, ordinal, position, path, target) VALUES
      ('wdg-1', 'registry', 0, 0, 'Field.Register.ksiazki', '{"kind":"registry","registryId":"${BOOKS.id}"}'),
      ('wdg-1', 'columns', 0, 1, 'Field.Register.ksiazki.strony', '{"kind":"column","registryId":"${BOOKS.id}","columnId":"${BOOKS.columns.find((column) => column.symbol === "strony")!.id}"}');
  `);
  return rig;
}

const registryOf = (rig: IdentityRig, symbol: string): StoredRegistry => unitOf(rig).read((ports) => ports.registries.find(OWNER, symbol))!;
const planOf = (registry: StoredRegistry, change: unknown, expiresAtMs = Date.now() + STRUCTURE_PLAN_TTL_MS): string =>
  signer.issue({ registryId: registry.id, schemaRevision: registry.schemaRevision, dataRevision: registry.dataRevision, expiresAtMs }, { ownerId: OWNER, change: canonicalChange(change) });
const apply = (rig: IdentityRig, symbol: string, change: unknown, planToken: string, unit = unitOf(rig), nowMs = Date.now()) =>
  unit.run((ports) => changeColumnType(ports, { signer, limits: DEFAULT_REGISTRY_LIMITS, nowMs }, { ownerId: OWNER, symbol, change, planToken, requestId: "req-d27-1" }));

/** Everything a rebuild could touch, as one text: the schema of the file and every table it changes. */
function state(rig: IdentityRig): string {
  const tables = ["registry", "registry_column", "screen", "widget", "binding", "audit_log", ...rig.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reg\\_%' ESCAPE '\\' ORDER BY 1").map((row) => row.name)];
  return JSON.stringify({ schema: rig.rows("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"), rows: tables.map((table) => rig.rows(`SELECT * FROM "${table}" ORDER BY 1`)) });
}

const stronyId = BOOKS.columns.find((column) => column.symbol === "strony")!.id;
const toText = { kind: "changeType", columnId: stronyId, type: "text" };

describe("D27.1-AC1 a column of F01 changes its type through the rebuild of its table", () => {
  it("strony number → text: the same 25 rows, their identifiers, times and revisions, the DDL and indexes of the new definition, revision 2, the audit without values, the bindings untouched", async () => {
    const rig = await booksRig();
    const before = rig.rows<Record<string, unknown>>("SELECT * FROM reg_ksiazki ORDER BY id");
    const bindings = rig.rows("SELECT * FROM binding ORDER BY position");
    const result = apply(rig, BOOKS.symbol, toText, planOf(registryOf(rig, BOOKS.symbol), toText));
    expect(result).toMatchObject({ ok: true, value: { value: { registryId: BOOKS.id, schemaRevision: 2, rows: 25, failed: 0 }, invalidations: [{ resource: "schema", ownerId: OWNER, resourceId: BOOKS.id }] } });

    const after = rig.rows<Record<string, unknown>>("SELECT * FROM reg_ksiazki ORDER BY id");
    expect(after).toHaveLength(25);
    after.forEach((row, index) => {
      const old = before[index]!;
      expect({ ...row, strony: undefined }).toEqual({ ...old, strony: undefined });
      expect(row["strony"]).toBe(String(old["strony"]));
    });
    expect(rig.rows("SELECT typeof(strony) AS t FROM reg_ksiazki GROUP BY 1")).toEqual([{ t: "text" }]);

    const registry = registryOf(rig, BOOKS.symbol);
    expect(registry).toMatchObject({ schemaRevision: 2, dataRevision: 25 });
    expect(registry.columns.find((column) => column.symbol === "strony")).toMatchObject({ id: stronyId, type: "text", typeOptions: {}, required: false });
    // The table is the one a new registry of this definition would get, and so are its indexes.
    const ddl = registryDdl({ symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: registry.columns });
    expect(rig.rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reg_ksiazki'")[0]!.sql).toBe(ddl.table);
    expect(rig.rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reg_ksiazki' AND sql IS NOT NULL ORDER BY name").map((row) => row.sql)).toEqual([...ddl.indexes].sort());
    expect(rig.rows("SELECT name FROM sqlite_master WHERE name LIKE '%rebuild%'")).toEqual([]);
    expect(rig.rows("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);

    const [audit] = rig.rows<{ action: string; entity_id: string; details: string }>("SELECT action, entity_id, details FROM audit_log WHERE action LIKE 'registry.%'");
    expect(audit).toMatchObject({ action: "registry.column_type_changed", entity_id: BOOKS.id });
    expect(JSON.parse(audit!.details)).toEqual({ registry: "ksiazki", column: "strony", fromType: "number", toType: "text", rows: 25, failed: 0 });
    expect(rig.rows("SELECT * FROM binding ORDER BY position")).toEqual(bindings);
  });

  it("S9 text → number: 12 is 12, abc is empty and counted; required with the replacement 0 takes it", async () => {
    const rig = await createIdentityRig();
    const columnId = "019a0000-0000-7000-8000-0000000000c1";
    const records = ["12", "abc", null].map((wynik, index): StoredRecord => ({ id: `019a0000-0000-7000-8000-00000000010${index}`, registryId: "reg-s9", ownerId: OWNER, revision: 1, createdAt: NOW, updatedAt: NOW, values: { wynik } }));
    registryRig(rig, { symbol: "pomiary", displayName: "Pomiary", columns: [{ symbol: "wynik", displayName: "Wynik", type: "text" }] }, "reg-s9", [columnId], records);
    const optional = { kind: "changeType", columnId, type: "number" };
    expect(apply(rig, "pomiary", optional, planOf(registryOf(rig, "pomiary"), optional))).toMatchObject({ ok: true, value: { value: { rows: 3, failed: 1 } } });
    expect(rig.rows("SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: 12 }, { wynik: null }, { wynik: null }]);

    // Back to text and then to a required number: the empty cells take the replacement.
    const back = { kind: "changeType", columnId, type: "text" };
    expect(apply(rig, "pomiary", back, planOf(registryOf(rig, "pomiary"), back))).toMatchObject({ ok: true });
    const required = { kind: "changeType", columnId, type: "number", required: true, replacement: 0 };
    expect(apply(rig, "pomiary", required, planOf(registryOf(rig, "pomiary"), required))).toMatchObject({ ok: true, value: { value: { schemaRevision: 4, failed: 0 } } });
    expect(rig.rows("SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: 12 }, { wynik: 0 }, { wynik: 0 }]);
    expect(registryOf(rig, "pomiary").columns[0]).toMatchObject({ type: "number", required: true });
  });
});

/** A handle whose statements matching `stage` throw after they ran `afterRuns` times: a failure after that stage. */
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

describe("D27.1-AC2 nothing of a rebuild that fails stays, and a plan that is not current changes nothing", () => {
  const STAGES: ReadonlyArray<[string, RegExp, number?]> = [
    ["1 the new table", /^CREATE TABLE "reg_ksiazki__rebuild"/],
    ["2 half of the copy", /^INSERT INTO "reg_ksiazki__rebuild"/, 13],
    ["2 the whole copy", /^INSERT INTO "reg_ksiazki__rebuild"/, 25],
    ["3 the check of the rows", /^PRAGMA foreign_key_check/],
    ["4 the old table dropped", /^DROP TABLE/],
    ["5 the new table renamed", /^ALTER TABLE/],
    ["6 the indexes", /^CREATE INDEX/, 2],
    ["7 the column in the catalog", /^UPDATE registry_column/],
    ["7 the schema revision", /^UPDATE registry SET schema_revision/],
    ["8 the audit", /^\s*INSERT INTO audit_log/],
  ];

  for (const [name, stage, afterRuns] of STAGES) {
    it(`a failure after stage ${name} leaves everything as it was`, async () => {
      const rig = await booksRig();
      const before = state(rig);
      const plan = planOf(registryOf(rig, BOOKS.symbol), toText);
      expect(() => apply(rig, BOOKS.symbol, toText, plan, unitOf(rig, failingAfter(stage, afterRuns)))).toThrow(/a failure injected after/);
      expect(state(rig)).toBe(before);
      // The plan is still current: the same change then succeeds.
      expect(apply(rig, BOOKS.symbol, toText, plan)).toMatchObject({ ok: true });
    });
  }

  it("a conversion that throws half-way through the copy, and a count of failures other than the report's, are taken back", async () => {
    const rig = await booksRig();
    const before = state(rig);
    const plan = planOf(registryOf(rig, BOOKS.symbol), toText);
    let seen = 0;
    const throwing = (inner: TableRebuild): TableRebuild => ({ rebuild: (registry, columns, changed) => inner.rebuild(registry, columns, { ...changed, rewrite: (value) => (++seen === 13 ? (() => { throw new Error("a conversion failed half-way"); })() : changed.rewrite(value)) }) });
    expect(() => apply(rig, BOOKS.symbol, toText, plan, unitOf(rig, undefined, throwing))).toThrow(/half-way/);
    expect(state(rig)).toBe(before);
    const miscounting = (inner: TableRebuild): TableRebuild => ({ rebuild: (registry, columns, changed) => inner.rebuild(registry, columns, { ...changed, rewrite: (value) => ({ ...changed.rewrite(value), failed: true }) }) });
    expect(() => apply(rig, BOOKS.symbol, toText, plan, unitOf(rig, undefined, miscounting))).toThrow(/other values than the report/);
    expect(state(rig)).toBe(before);
  });

  it("a plan made stale by a record, of another change, of another owner or past its time changes nothing", async () => {
    const rig = await booksRig();
    const plan = planOf(registryOf(rig, BOOKS.symbol), toText);
    const before = state(rig);
    expect(apply(rig, BOOKS.symbol, { ...toText, type: "money" }, plan)).toEqual({ ok: false, error: { code: "PLAN_INVALID" } });
    const foreign = signer.issue({ registryId: BOOKS.id, schemaRevision: 1, dataRevision: 25, expiresAtMs: Date.now() + 60_000 }, { ownerId: "someone-else", change: canonicalChange(toText) });
    expect(apply(rig, BOOKS.symbol, toText, foreign)).toEqual({ ok: false, error: { code: "PLAN_INVALID" } });
    expect(apply(rig, BOOKS.symbol, toText, plan, unitOf(rig), Date.now() + STRUCTURE_PLAN_TTL_MS)).toEqual({ ok: false, error: { code: "PLAN_EXPIRED" } });
    expect(state(rig)).toBe(before);

    unitOf(rig).run((ports) => {
      ports.records.insert(ports.registries.find(OWNER, BOOKS.symbol)!, { id: "019a0000-0000-7000-8000-000000000fff", registryId: BOOKS.id, ownerId: OWNER, revision: 1, createdAt: NOW, updatedAt: NOW, values: { tytul: "Nowa" } });
      return done(null);
    });
    const withRecord = state(rig);
    expect(apply(rig, BOOKS.symbol, toText, plan)).toEqual({ ok: false, error: { code: "PLAN_STALE" } });
    expect(state(rig)).toBe(withRecord);
  });

  it("50 000 records of ten columns: a type change rebuilds the table, p95 of five runs and the growth of the WAL measured", async () => {
    const rig = await createIdentityRig();
    const columns = [
      { symbol: "tytul", displayName: "Tytuł", type: "text" },
      { symbol: "autor", displayName: "Autor", type: "text" },
      { symbol: "strony", displayName: "Strony", type: "number" },
      { symbol: "cena", displayName: "Cena", type: "money" },
      { symbol: "data", displayName: "Data", type: "date" },
      { symbol: "rozpoczeto", displayName: "Rozpoczęto", type: "datetime" },
      { symbol: "godzina", displayName: "Godzina", type: "time" },
      { symbol: "ponowne", displayName: "Ponowne", type: "boolean" },
      { symbol: "status", displayName: "Status", type: "choice" },
      { symbol: "opis", displayName: "Opis", type: "text" },
    ];
    const ids = columns.map((_, index) => `019a0000-0000-7000-8000-0000000002${String(index).padStart(2, "0")}`);
    registryRig(rig, { symbol: "duzy", displayName: "Duży", columns }, "reg-big", ids, []);
    const COUNT = 50_000;
    const insert = rig.connection.handle.prepare(`INSERT INTO reg_duzy (id, user_id, created_at, updated_at, revision, tytul, autor, strony, cena, data, rozpoczeto, godzina, ponowne, status, opis) VALUES (?, '${OWNER}', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rig.connection.handle.transaction(() => {
      for (let index = 0; index < COUNT; index += 1) {
        const at = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
        insert.run(`019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`, at, at, `Pozycja ${index}`, `Autor ${index % 997}`, index % 900, index * 3, "2026-10-01", at, "07:30", index % 2, index % 2 === 0 ? "czytam" : "planowane", index % 3 === 0 ? null : `opis ${index}`);
      }
      rig.connection.handle.prepare("UPDATE registry SET data_revision = ? WHERE symbol = 'duzy'").run(COUNT);
    })();
    rig.connection.handle.pragma("wal_checkpoint(TRUNCATE)");
    const wal = `${rig.file}-wal`;
    const strony = ids[2]!;
    const times: number[] = [];
    let walGrowth = 0;
    for (let run = 0; run < 5; run += 1) {
      const change = { kind: "changeType", columnId: strony, type: run % 2 === 0 ? "text" : "number" };
      const plan = planOf(registryOf(rig, "duzy"), change);
      const walBefore = statSync(wal).size;
      const started = performance.now();
      const result = apply(rig, "duzy", change, plan);
      times.push(performance.now() - started);
      walGrowth = Math.max(walGrowth, statSync(wal).size - walBefore);
      expect(result).toMatchObject({ ok: true, value: { value: { rows: COUNT, failed: 0 } } });
      rig.connection.handle.pragma("wal_checkpoint(TRUNCATE)");
    }
    times.sort((a, b) => a - b);
    const p95 = times[times.length - 1]!;
    process.stdout.write(
      `D27.1 measurement (${process.platform} ${process.arch}, Node ${process.versions.node}, ${COUNT} records, 10 columns, number ↔ text, 5 runs): rebuild p95 ${p95.toFixed(0)} ms, median ${times[2]!.toFixed(0)} ms, WAL growth up to ${(walGrowth / 1024 / 1024).toFixed(1)} MiB, database ${(statSync(rig.file).size / 1024 / 1024).toFixed(1)} MiB\n`,
    );
    expect(rig.rows("SELECT count(*) AS n FROM reg_duzy")).toEqual([{ n: COUNT }]);
    expect(rig.rows("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    // The threshold of the work order (1 s) is decided by the measurement written above, on a stated
    // machine; a shared CI runner is no such machine, so here only an order of magnitude is guarded.
    expect(p95).toBeLessThan(20_000);
  }, 180_000);
});
