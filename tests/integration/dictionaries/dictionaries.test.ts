// D24.1 — the dictionaries on a real SQLite file (Scope §5.8, S7; Architektura §4.2, §5.2, §13.4):
// the production adapters and use cases in one unit of work. The access policy is the one input
// stood in for: a gate that lets the owner's token through and refuses any other; every state of the
// real gate is checked over HTTP in D24.2.
// AC1: the dictionary of F01 is created, read in its order and saved whole with revision + 1; the
//      lookup gives "Archiwalne" for the hidden value and nothing for `spoza_slownika`; deleting it
//      unpins the column of Książki, raises its schema revision and changes no record.
// AC2: a stale revision writes nothing; a taken symbol and the limit are conflicts; a dictionary of
//      another owner is neither read nor labelled; a failure in the unit takes the dictionary, the
//      unpinning and the audit back together.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDictionary, DEFAULT_DICTIONARY_LIMITS, deleteDictionary, getDictionary, listDictionaries, saveDictionary } from "../../../packages/core/dist/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS, validateNewRegistry, type StoredRecord } from "../../../packages/core/dist/modules/registries/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindDictionaryLookup, bindDictionaryStore } from "../../../packages/sqlite/dist/adapters/dictionaries/public.js";
import { bindColumnDictionaryLinks, bindRecordStore, bindRegistryStore } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { closeRigs, createIdentityRig, done, RIG_T0, type IdentityRig } from "../../support/identity-rig.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(closeRigs);

type FixtureDictionary = { id: string; symbol: string; displayName: string; values: Array<{ symbol: string; label: string; hidden: boolean }> };
type FixtureRegistry = { symbol: string; displayName: string; columns: Array<Record<string, unknown> & { symbol: string; typeOptions: Record<string, unknown> }>; records: Array<{ id: string; createdAt: string; values: Record<string, string | number | boolean | null> }> };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { dictionaries: FixtureDictionary[]; registries: FixtureRegistry[] };
const expected = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { statusCounts: Record<string, number>; hiddenLabel: string; unknownValueDisplayedAs: string };
const STATUS = fixture.dictionaries[0]!;
const BOOKS = fixture.registries[0]!;
const OWNER = "owner-1";
const TOKEN = "owner-token";
const statusDraft = () => ({ symbol: STATUS.symbol, displayName: STATUS.displayName, values: STATUS.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })) });

/** The gate stood in for: the owner's token passes the data access, any other has no session. */
const gate = {
  sessions: { findActive: (token: string) => (token === TOKEN ? { sessionId: "s-1", ownerId: OWNER, assurance: "totp" as const, passwordVerifiedAtMs: RIG_T0, totpVerifiedAtMs: RIG_T0, accessEpoch: 1 } : null) },
  access: { current: () => ({ ownerExists: true, ownerMatches: true, sessionState: "active" as const, epochMatches: true, mfaPolicy: "required" as const, enrollmentState: "complete" as const, assurance: "totp" as const, trustedState: "not_used" as const, dataChoice: "empty" as const, totpVerifiedAtMs: RIG_T0, passwordVerifiedAtMs: RIG_T0 }) },
};

let ids = 0;
const newId = () => `019a0000-0000-7000-8000-${String((ids += 1)).padStart(12, "0")}`;

function setup(rig: IdentityRig, failing?: { audit?: boolean }) {
  const unit = createUnitOfWork(rig.connection, (tx) => {
    const audit = bindAppendAudit(tx);
    return {
      ...gate,
      dictionaries: bindDictionaryStore(tx),
      columnLinks: bindColumnDictionaryLinks(tx),
      audit: failing?.audit === true ? { append: () => { throw new Error("the audit failed"); } } : audit,
      lookup: bindDictionaryLookup(tx),
      registries: bindRegistryStore(tx),
      records: bindRecordStore(tx),
    };
  });
  const deps = { unit, nowMs: () => rig.clock.now, newId, limits: DEFAULT_DICTIONARY_LIMITS };
  return { unit, deps };
}

/** Książki of F01 with its "Status" column on the dictionary given, and its 25 records. */
function books(rig: IdentityRig, dictionaryId: string): void {
  const { unit } = setup(rig);
  unit.run((ports) => {
    const columns = BOOKS.columns.map((column) => (column.symbol === "status" ? { ...column, typeOptions: { dictionaryId } } : column));
    const checked = validateNewRegistry({ symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns }, { limits: DEFAULT_REGISTRY_LIMITS, takenRegistrySymbols: new Set(), activeRegistryCount: 0, dictionaryIds: ports.lookup.ids(OWNER) });
    if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
    ports.registries.insert({ id: "019a0000-0000-7000-8000-000000000064", ownerId: OWNER, columnIds: columns.map(() => newId()), definition: checked.value, nowIso: new Date(RIG_T0).toISOString() });
    const registry = ports.registries.find(OWNER, BOOKS.symbol)!;
    for (const record of BOOKS.records) ports.records.insert({ ...registry, schemaRevision: registry.schemaRevision }, { id: record.id, registryId: registry.id, ownerId: OWNER, revision: 1, createdAt: record.createdAt, updatedAt: record.createdAt, values: record.values } as StoredRecord);
    return done(null);
  });
}

const records = (rig: IdentityRig) => rig.rows<Record<string, unknown>>("SELECT * FROM reg_ksiazki ORDER BY id");
const statusColumn = (rig: IdentityRig) => rig.rows<{ type: string; type_options: string }>("SELECT type, type_options FROM registry_column WHERE symbol = 'status'")[0]!;
const schemaRevision = (rig: IdentityRig) => rig.rows<{ schema_revision: number }>("SELECT schema_revision FROM registry")[0]!.schema_revision;
const audits = (rig: IdentityRig) => rig.rows<{ action: string; details: string }>("SELECT action, details FROM audit_log WHERE action LIKE 'dictionary.%' ORDER BY rowid");
const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe("D24.1-AC1 the dictionary of F01 in SQLite", () => {
  it("is created, read in its order, labelled through the lookup of the registries and saved whole with revision + 1", async () => {
    const rig = await createIdentityRig();
    const { unit, deps } = setup(rig);
    const created = value(createDictionary(deps, TOKEN, statusDraft(), "req-1"));
    expect(created).toMatchObject({ ownerId: OWNER, symbol: STATUS.symbol, displayName: STATUS.displayName, revision: 1 });
    expect(created.values.map(({ symbol, label, hidden, position }) => ({ symbol, label, hidden, position }))).toEqual(STATUS.values.map(({ symbol, label, hidden }, position) => ({ symbol, label, hidden, position })));

    // The lookup of the registries: a hidden value keeps its label, a symbol the dictionary does not have gets none.
    const labels = unit.read((ports) => ports.lookup.labels(OWNER, created.id, ["planowane", "archiwalne", "spoza_slownika", "planowane"]));
    expect(Object.fromEntries(labels)).toEqual({ planowane: "Planowane", archiwalne: expected.hiddenLabel });
    expect(labels.has(expected.unknownValueDisplayedAs)).toBe(false);
    expect(unit.read((ports) => ports.lookup.labels("someone-else", created.id, ["planowane"])).size).toBe(0);

    // A save: new order, a label and a hidden flag changed, one value removed, one added; the kept values keep their identifiers.
    const content = { displayName: "Status książki", values: [{ symbol: "ukonczone", label: "Przeczytana", hidden: false }, { symbol: "planowane", label: "W planie", hidden: true }, { symbol: "czytane", label: "W trakcie", hidden: false }, { symbol: "porzucone", label: "Porzucone", hidden: false }] };
    const saved = value(saveDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1, content }, "req-2"));
    expect(saved).toMatchObject({ displayName: "Status książki", revision: 2 });
    expect(saved.values.map(({ symbol, label, hidden, position }) => ({ symbol, label, hidden, position }))).toEqual(content.values.map((each, position) => ({ ...each, position })));
    const idOf = (dictionary: typeof created, symbol: string) => dictionary.values.find((each) => each.symbol === symbol)?.id;
    expect(idOf(saved, "planowane")).toBe(idOf(created, "planowane"));
    expect(Object.fromEntries(unit.read((ports) => ports.lookup.labels(OWNER, created.id, ["archiwalne", "planowane"])))).toEqual({ planowane: "W planie" });

    rig.reopen();
    const again = setup(rig);
    expect(value(getDictionary(again.deps, TOKEN, STATUS.symbol, "req-3")).dictionary).toEqual(saved);
    expect(audits(rig).map((entry) => [entry.action, JSON.parse(entry.details) as unknown])).toEqual([
      ["dictionary.created", { symbol: STATUS.symbol, values: 4 }],
      ["dictionary.updated", { symbol: STATUS.symbol, values: 4, added: "porzucone", removed: "archiwalne" }],
    ]);
  });

  it("the list has the columns that use each dictionary; deleting it unpins the column of Książki, raises its schema revision and changes no record (S7)", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    const created = value(createDictionary(deps, TOKEN, statusDraft(), "req-1"));
    value(createDictionary(deps, TOKEN, { symbol: "nieuzywany", displayName: "Nieużywany" }, "req-2"));
    books(rig, created.id);
    const before = records(rig);
    expect(before).toHaveLength(25);
    const counts = Object.fromEntries(Object.keys(expected.statusCounts).map((status) => [status, before.filter((row) => row["status"] === status).length]));
    expect(counts).toEqual(expected.statusCounts);

    const listed = value(listDictionaries(deps, TOKEN, "req-3"));
    expect(listed.map((entry) => [entry.dictionary.symbol, entry.usages.map((usage) => `${usage.registrySymbol}.${usage.columnSymbol} (${usage.registryName} · ${usage.columnName})`)])).toEqual([
      [STATUS.symbol, ["ksiazki.status (Książki · Status)"]],
      ["nieuzywany", []],
    ]);

    const unpinned = value(deleteDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1 }, "req-4"));
    expect(unpinned.map((usage) => usage.columnSymbol)).toEqual(["status"]);
    expect(statusColumn(rig)).toEqual({ type: "choice", type_options: "{}" });
    expect(schemaRevision(rig)).toBe(2);
    expect(records(rig)).toEqual(before);
    expect(rig.rows("SELECT * FROM dictionary_value WHERE dictionary_id = '" + created.id + "'")).toEqual([]);
    expect(getDictionary(deps, TOKEN, STATUS.symbol, "req-5")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(audits(rig).at(-1)).toEqual({ action: "dictionary.deleted", details: JSON.stringify({ symbol: STATUS.symbol, unpinnedColumns: "ksiazki.status" }) });
    // The symbol is free again: a dictionary is deleted with its values and has no data of its own to keep.
    expect(createDictionary(deps, TOKEN, statusDraft(), "req-6").ok).toBe(true);
  });
});

describe("D24.1-AC2 what is refused, and what is taken back", () => {
  it("a stale revision writes nothing; a taken symbol and the limit are conflicts; a bad content is invalid with its paths; another token is not let in", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    value(createDictionary(deps, TOKEN, statusDraft(), "req-1"));
    value(saveDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1, content: { displayName: "Pierwsza", values: [] } }, "req-2"));
    const state = () => rig.rows("SELECT d.revision, d.display_name, count(v.id) AS n FROM dictionary d LEFT JOIN dictionary_value v ON v.dictionary_id = d.id GROUP BY d.id");
    const before = state();
    expect(saveDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1, content: { displayName: "Druga", values: [] } }, "req-3")).toEqual({ ok: false, error: { code: "DICTIONARY_CHANGED" } });
    expect(deleteDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1 }, "req-4")).toEqual({ ok: false, error: { code: "DICTIONARY_CHANGED" } });
    expect(state()).toEqual(before);

    expect(createDictionary(deps, TOKEN, statusDraft(), "req-5")).toEqual({ ok: false, error: { code: "DICTIONARY_SYMBOL_TAKEN", fields: ["symbol"] } });
    const invalid = saveDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 2, content: { displayName: "", values: [{ symbol: "a", label: "A" }, { symbol: "a", label: "B" }] } }, "req-6");
    expect(invalid).toEqual({ ok: false, error: { code: "VALIDATION_FAILED", fields: ["displayName", "values.1.symbol"], issues: [{ path: "displayName", code: "NAME_EMPTY" }, { path: "values.1.symbol", code: "SYMBOL_TAKEN" }] } });
    expect(saveDictionary(deps, TOKEN, { symbol: "nieznany", expectedRevision: 1, content: { displayName: "X" } }, "req-7")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    for (const call of [() => createDictionary(deps, "other", statusDraft(), "r"), () => listDictionaries(deps, "other", "r"), () => getDictionary(deps, "other", STATUS.symbol, "r"), () => deleteDictionary(deps, "other", { symbol: STATUS.symbol, expectedRevision: 2 }, "r")]) {
      expect(call()).toEqual({ ok: false, error: { code: "AUTH_REQUIRED" } });
    }
    expect(state()).toEqual(before);

    const limited = { ...deps, limits: { ...DEFAULT_DICTIONARY_LIMITS, maxDictionaries: 1 } };
    expect(createDictionary(limited, TOKEN, { symbol: "drugi", displayName: "Drugi" }, "req-8")).toEqual({ ok: false, error: { code: "DICTIONARY_LIMIT_EXCEEDED" } });
  });

  it("a dictionary of another owner is not found, listed, saved or deleted by the owner, and a column cannot name it", async () => {
    const rig = await createIdentityRig();
    const { unit, deps } = setup(rig);
    rig.sql(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('someone-else', 'x', 'x@example.test', 0, '2026-10-26T12:00:00Z', '2026-10-26T12:00:00Z')`);
    unit.run((ports) => {
      ports.dictionaries.insert({ id: "019a0000-0000-7000-8000-0000000fffff", ownerId: "someone-else", symbol: STATUS.symbol, content: { displayName: "Obcy", values: [{ symbol: "planowane", label: "Obca", hidden: false }] }, valueIds: ["019a0000-0000-7000-8000-0000000ffffe"], nowIso: "2026-10-26T12:00:00Z" });
      return done(null);
    });
    expect(value(listDictionaries(deps, TOKEN, "r"))).toEqual([]);
    expect(getDictionary(deps, TOKEN, STATUS.symbol, "r")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(saveDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1, content: { displayName: "Moje" } }, "r")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(deleteDictionary(deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1 }, "r")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(unit.read((ports) => ports.lookup.ids(OWNER)).size).toBe(0);
    expect(rig.rows("SELECT display_name FROM dictionary")).toEqual([{ display_name: "Obcy" }]);
    // The owner's own dictionary with the same symbol is a dictionary of its own.
    expect(createDictionary(deps, TOKEN, statusDraft(), "r").ok).toBe(true);
  });

  it("a failing audit takes back the dictionary, and a delete with its unpinning and schema revision", async () => {
    const rig = await createIdentityRig();
    const ok = setup(rig);
    const created = value(createDictionary(ok.deps, TOKEN, statusDraft(), "req-1"));
    books(rig, created.id);
    const broken = setup(rig, { audit: true });
    expect(() => createDictionary(broken.deps, TOKEN, { symbol: "drugi", displayName: "Drugi" }, "req-2")).toThrow(/audit failed/);
    expect(rig.rows("SELECT symbol FROM dictionary")).toEqual([{ symbol: STATUS.symbol }]);
    const before = { column: statusColumn(rig), revision: schemaRevision(rig), values: rig.rows("SELECT * FROM dictionary_value ORDER BY position"), records: records(rig) };
    expect(() => deleteDictionary(broken.deps, TOKEN, { symbol: STATUS.symbol, expectedRevision: 1 }, "req-3")).toThrow(/audit failed/);
    expect({ column: statusColumn(rig), revision: schemaRevision(rig), values: rig.rows("SELECT * FROM dictionary_value ORDER BY position"), records: records(rig) }).toEqual(before);
    expect(JSON.parse(before.column.type_options)).toEqual({ dictionaryId: created.id });
  });
});
