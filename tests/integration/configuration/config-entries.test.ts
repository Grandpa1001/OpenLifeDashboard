// D25.1 — the entries of ConfigTable on a real SQLite file (Scope §5.7, S17; Architektura §4.2,
// §9.5, §13.4): the production adapters and use cases in one unit of work. The access policy is the
// one input stood in for: a gate that lets the owner's token through and refuses any other; every
// state of the real gate is checked over HTTP in D25.2.
// AC1: the entry of F01 (`norma_czytania` = "20") is created and read as text, through the reader
//      of `Field.Config` too; a save of the whole on revision 1 gives revision 2, and the audit of the
//      database holds the old and the new value; the list counts the bindings that point at an
//      entry; a delete frees the symbol and the audit keeps the last value.
// AC2: a stale revision writes nothing and audits nothing; a taken symbol and the limit are
//      conflicts; a bad content is invalid with its paths and never its value; an entry of another
//      owner is neither read nor changed; a failing audit takes the change back.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigEntry, DEFAULT_CONFIG_LIMITS, deleteConfigEntry, getConfigEntry, listConfigEntries, saveConfigEntry } from "../../../packages/core/dist/modules/configuration/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindConfigReader, bindConfigStore } from "../../../packages/sqlite/dist/adapters/configuration/public.js";
import { bindConfigBindingCounts } from "../../../packages/sqlite/dist/adapters/dashboard/public.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { closeRigs, createIdentityRig, RIG_T0, type IdentityRig } from "../../support/identity-rig.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(closeRigs);

type FixtureEntry = { id: string; symbol: string; displayName: string; value: string; description: string };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { configEntries: FixtureEntry[] };
const NORMA = fixture.configEntries[0]!;
const OWNER = "owner-1";
const TOKEN = "owner-token";
const normaDraft = () => ({ symbol: NORMA.symbol, displayName: NORMA.displayName, value: NORMA.value, description: NORMA.description });

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
      config: bindConfigStore(tx),
      configBindings: bindConfigBindingCounts(tx),
      reader: bindConfigReader(tx),
      audit: failing?.audit === true ? { append: () => { throw new Error("the audit failed"); } } : audit,
    };
  });
  return { unit, deps: { unit, nowMs: () => rig.clock.now, newId, limits: DEFAULT_CONFIG_LIMITS } };
}

const audits = (rig: IdentityRig) => rig.rows<{ action: string; details: string }>("SELECT action, details FROM audit_log WHERE action LIKE 'config.%' ORDER BY rowid").map((entry) => [entry.action, JSON.parse(entry.details) as unknown]);
const entries = (rig: IdentityRig) => rig.rows("SELECT * FROM config_entry ORDER BY id");
const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

/** A screen of the owner with one widget whose bindings point at the entries given; a type that takes an entry is after the MVP, so the rows are written as such a type would leave them. */
function bindingsTo(rig: IdentityRig, entryIds: readonly string[]): void {
  const screen = "019a0000-0000-7000-8000-0000000c0001";
  const widget = "019a0000-0000-7000-8000-0000000c0002";
  const layout = JSON.stringify({ phone: { x: 0, y: 0, w: 1, h: 4 }, tablet: { x: 0, y: 0, w: 4, h: 4 }, desktop: { x: 0, y: 0, w: 4, h: 4 } });
  rig.sql(`INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES ('${screen}', '${OWNER}', 'Ekran', 'dark', 'blue', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
  rig.sql(`INSERT INTO widget (id, screen_id, position, type, config, layout, state) VALUES ('${widget}', '${screen}', 0, 'progress', '{"v":1}', '${layout}', 'ok')`);
  entryIds.forEach((entryId, ordinal) => rig.sql(`INSERT INTO binding (widget_id, slot, ordinal, position, path, target) VALUES ('${widget}', 'norm', ${ordinal}, ${ordinal}, 'Field.Config.x', '${JSON.stringify({ kind: "config", entryId })}')`));
}

describe("D25.1-AC1 the entry of F01 in SQLite", () => {
  it("is created and read as the text \"20\", also through the reader of Field.Config, and saved whole with revision + 1 and both values in the audit", async () => {
    const rig = await createIdentityRig();
    const { unit, deps } = setup(rig);
    const created = value(createConfigEntry(deps, TOKEN, normaDraft(), "req-1"));
    expect(created).toMatchObject({ ownerId: OWNER, symbol: "norma_czytania", displayName: "Norma czytania", value: "20", description: NORMA.description, revision: 1 });
    expect(rig.rows("SELECT value, typeof(value) AS type FROM config_entry")).toEqual([{ value: "20", type: "text" }]);
    expect(unit.read((ports) => ports.reader.entry(OWNER, created.id))).toEqual({ symbol: "norma_czytania", value: "20" });
    expect(unit.read((ports) => ports.reader.entry("someone-else", created.id))).toBeNull();

    // A value is kept as it was sent: spaces and a new line too.
    const saved = value(saveConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1, content: { displayName: "Norma czytania dziennie", value: " 25 stron\n", description: "" } }, "req-2"));
    expect(saved).toMatchObject({ displayName: "Norma czytania dziennie", value: " 25 stron\n", description: "", revision: 2 });
    // A save that changes only the name is a change of its own, with the value on both sides.
    value(saveConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 2, content: { displayName: "Norma", value: " 25 stron\n" } }, "req-3"));

    rig.reopen();
    const again = setup(rig);
    expect(value(getConfigEntry(again.deps, TOKEN, NORMA.symbol, "req-4"))).toEqual({ entry: { ...saved, displayName: "Norma", revision: 3, updatedAt: saved.updatedAt }, bindings: 0 });
    expect(audits(rig)).toEqual([
      ["config.created", { symbol: "norma_czytania", value: "20" }],
      ["config.updated", { symbol: "norma_czytania", oldValue: "20", newValue: " 25 stron\n" }],
      ["config.updated", { symbol: "norma_czytania", oldValue: " 25 stron\n", newValue: " 25 stron\n" }],
    ]);
  });

  it("the list counts the bindings of each entry; a delete frees the symbol, leaves the bindings and keeps the last value in the audit", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    const norma = value(createConfigEntry(deps, TOKEN, normaDraft(), "req-1"));
    const urlop = value(createConfigEntry(deps, TOKEN, { symbol: "data_urlopu", displayName: "Data urlopu", value: "2027-07-01" }, "req-2"));
    bindingsTo(rig, [norma.id, norma.id]);
    expect(value(listConfigEntries(deps, TOKEN, "req-3")).map((each) => [each.entry.symbol, each.entry.value, each.bindings])).toEqual([
      ["norma_czytania", "20", 2],
      ["data_urlopu", "2027-07-01", 0],
    ]);

    expect(value(deleteConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1 }, "req-4"))).toEqual({ bindings: 2 });
    expect(getConfigEntry(deps, TOKEN, NORMA.symbol, "req-5")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    // The bindings stay, pointing at nothing: the widget is to be bound again (the rule is in the unit test of D25.1).
    expect(rig.rows("SELECT count(*) AS n FROM binding")).toEqual([{ n: 2 }]);
    expect(audits(rig).at(-1)).toEqual(["config.deleted", { symbol: "norma_czytania", oldValue: "20", bindings: 2 }]);
    expect(value(createConfigEntry(deps, TOKEN, normaDraft(), "req-6")).id).not.toBe(norma.id);
    expect(value(listConfigEntries(deps, TOKEN, "req-7")).map((each) => [each.entry.symbol, each.bindings])).toEqual([
      ["data_urlopu", 0],
      ["norma_czytania", 0],
    ]);
    expect(urlop.revision).toBe(1);
  });
});

describe("D25.1-AC2 what is refused, and what is taken back", () => {
  it("a stale revision writes and audits nothing; a taken symbol and the limit are conflicts; a bad content is invalid with its paths and without its value; another token is not let in", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    value(createConfigEntry(deps, TOKEN, normaDraft(), "req-1"));
    value(saveConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1, content: { displayName: "Norma", value: "30" } }, "req-2"));
    const before = { entries: entries(rig), audits: audits(rig) };
    expect(saveConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1, content: { displayName: "Norma", value: "40" } }, "req-3")).toEqual({ ok: false, error: { code: "CONFIG_CHANGED" } });
    expect(deleteConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1 }, "req-4")).toEqual({ ok: false, error: { code: "CONFIG_CHANGED" } });
    expect({ entries: entries(rig), audits: audits(rig) }).toEqual(before);

    expect(createConfigEntry(deps, TOKEN, normaDraft(), "req-5")).toEqual({ ok: false, error: { code: "CONFIG_SYMBOL_TAKEN", fields: ["symbol"] } });
    const secret = "ten-tekst-nie-trafia-do-odmowy";
    const invalid = saveConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 2, content: { displayName: "", value: 20, description: `${secret}\u0007` } }, "req-6");
    expect(invalid).toEqual({ ok: false, error: { code: "VALIDATION_FAILED", fields: ["displayName", "value", "description"], issues: [{ path: "displayName", code: "NAME_EMPTY" }, { path: "value", code: "VALUE_NOT_TEXT" }, { path: "description", code: "DESCRIPTION_INVALID" }] } });
    expect(JSON.stringify(invalid)).not.toContain(secret);
    expect(saveConfigEntry(deps, TOKEN, { symbol: "nieznany", expectedRevision: 1, content: { displayName: "X", value: "" } }, "req-7")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    for (const call of [() => createConfigEntry(deps, "other", normaDraft(), "r"), () => listConfigEntries(deps, "other", "r"), () => getConfigEntry(deps, "other", NORMA.symbol, "r"), () => saveConfigEntry(deps, "other", { symbol: NORMA.symbol, expectedRevision: 2, content: { displayName: "X", value: "" } }, "r"), () => deleteConfigEntry(deps, "other", { symbol: NORMA.symbol, expectedRevision: 2 }, "r")]) {
      expect(call()).toEqual({ ok: false, error: { code: "AUTH_REQUIRED" } });
    }
    expect({ entries: entries(rig), audits: audits(rig) }).toEqual(before);

    const limited = { ...deps, limits: { ...DEFAULT_CONFIG_LIMITS, maxEntries: 1 } };
    expect(createConfigEntry(limited, TOKEN, { symbol: "drugi", displayName: "Drugi", value: "" }, "req-8")).toEqual({ ok: false, error: { code: "CONFIG_LIMIT_EXCEEDED" } });
  });

  it("an entry of another owner is not found, listed, saved or deleted by the owner; the same symbol is the owner's own", async () => {
    const rig = await createIdentityRig();
    const { unit, deps } = setup(rig);
    rig.sql(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('someone-else', 'x', 'x@example.test', 0, '2026-10-26T12:00:00Z', '2026-10-26T12:00:00Z')`);
    unit.run((ports) => {
      ports.config.insert({ id: "019a0000-0000-7000-8000-0000000fffff", ownerId: "someone-else", symbol: NORMA.symbol, content: { displayName: "Obca", value: "99", description: "" }, nowIso: "2026-10-26T12:00:00Z" });
      return { value: null, invalidations: [] };
    });
    expect(value(listConfigEntries(deps, TOKEN, "r"))).toEqual([]);
    expect(getConfigEntry(deps, TOKEN, NORMA.symbol, "r")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(saveConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1, content: { displayName: "Moja", value: "1" } }, "r")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(deleteConfigEntry(deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1 }, "r")).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
    expect(unit.read((ports) => ports.reader.entry(OWNER, "019a0000-0000-7000-8000-0000000fffff"))).toBeNull();
    expect(rig.rows("SELECT display_name, value FROM config_entry")).toEqual([{ display_name: "Obca", value: "99" }]);
    expect(createConfigEntry(deps, TOKEN, normaDraft(), "r").ok).toBe(true);
  });

  it("a failing audit takes back a creation, a save and a delete", async () => {
    const rig = await createIdentityRig();
    const ok = setup(rig);
    value(createConfigEntry(ok.deps, TOKEN, normaDraft(), "req-1"));
    const before = entries(rig);
    const broken = setup(rig, { audit: true });
    expect(() => createConfigEntry(broken.deps, TOKEN, { symbol: "drugi", displayName: "Drugi", value: "" }, "req-2")).toThrow(/audit failed/);
    expect(() => saveConfigEntry(broken.deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1, content: { displayName: "Norma", value: "21" } }, "req-3")).toThrow(/audit failed/);
    expect(() => deleteConfigEntry(broken.deps, TOKEN, { symbol: NORMA.symbol, expectedRevision: 1 }, "req-4")).toThrow(/audit failed/);
    expect(entries(rig)).toEqual(before);
    expect(audits(rig)).toEqual([["config.created", { symbol: "norma_czytania", value: "20" }]]);
  });
});
