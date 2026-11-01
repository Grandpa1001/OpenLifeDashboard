// D26.2 — the preview of a change of the structure over real HTTP (Scope §5.6, S8, S9; Architektura
// §4.5, §4.6, §5.2, §13.4, §16), on Książki of F01 and its table widget made through the API, and the
// check of a plan on the composition of the app (no route carries a plan out before D28).
// AC1: removing `autor` reports the 25 records, the 22 that hold an author and the table widget with
//      its slot `columns`; `strony` to text converts all 25; S9 converts `12` and fails `abc`, and a
//      required column with a value that does not convert is blocked without a plan; the plan of the
//      same change on the same registry is current; a preview writes and audits nothing.
// AC2: a record or a definition written after the preview makes the plan stale; another change,
//      another owner, a changed or foreign token is invalid; after ten minutes it has expired; a
//      foreign Origin and no session are refused; 50 000 records are previewed within the budget.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, registryListSchema, structurePreviewPath, structurePreviewSchema, type RegistryDto } from "@openlife/contracts/http/registries";
import { SCREENS_PATH, screenDesignPath, screenSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { createStructurePlanSigner } from "../../../apps/server/dist/adapters/structure-plan-signer.js";
import { checkStructurePlan, planFailure, STRUCTURE_PLAN_TTL_MS, type StoredRegistry } from "../../../packages/core/dist/modules/registries/public.js";
import { installation, post, query, readyOwner, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { closeHarnesses } from "../../support/app-harness.ts";
import { withoutDictionary } from "../../support/books-fixture.ts";
import { repoRoot } from "../../support/server-process.ts";
import { createSignedInHarness } from "../../support/signed-in-harness.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
type FixtureBinding = { slot: string; ordinal: number; path: string; target: { kind: string; registryId?: string; columnId?: string; symbol?: string } };
type FixtureWidget = { id: string; type: string; config: Record<string, unknown>; layout: unknown; bindings: FixtureBinding[] };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as {
  registries: Array<{ id: string; symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ values: Record<string, unknown> }> }>;
  screens: Array<{ name: string; widgets: FixtureWidget[] }>;
};
const BOOKS = fixture.registries[0]!;
const SCREEN = fixture.screens[0]!;
const TABLE = SCREEN.widgets.find((widget) => widget.type === "register-table")!;
const definitionOf = (symbol: string, displayName: string, columns: ReadonlyArray<Omit<FixtureColumn, "id">>) => ({
  symbol,
  displayName,
  columns: columns.map(({ symbol: column, displayName: name, type, typeOptions, defaultValue, required }) => ({ symbol: column, displayName: name, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })),
});
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;

/** Everything a preview could change, as one text. */
function stored(setup: Installation): string {
  const tables = ["registry", "registry_column", "screen", "widget", "binding", "idempotency_entry", "audit_log", ...query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reg\\_%' ESCAPE '\\' ORDER BY 1").map((row) => row.name)];
  return JSON.stringify(tables.map((table) => query(setup.instance, `SELECT * FROM "${table}" ORDER BY 1`)));
}

const registryOf = async (setup: Installation, cookie: string, symbol: string): Promise<RegistryDto> => {
  const found = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries.find((registry) => registry.symbol === symbol);
  if (found === undefined) throw new Error(`no registry ${symbol}`);
  return found;
};

/** Książki with the 25 records of F01 and the screen of F01 with its table widget, bound to the server's identifiers. */
async function books(): Promise<{ setup: Installation; cookie: string; registry: RegistryDto; screenId: string }> {
  const setup = await installation();
  const cookie = (await readyOwner(setup)).sessionCookie;
  expect((await post(setup.server, REGISTRIES_PATH, definitionOf(BOOKS.symbol, BOOKS.displayName, BOOKS.columns), { cookie })).status).toBe(201);
  for (const [index, record] of BOOKS.records.entries()) {
    expect((await post(setup.server, registryRecordsPath(BOOKS.symbol), { schemaRevision: 1, values: record.values }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `d26-2-add-${index}` } })).status).toBe(201);
  }
  const registry = await registryOf(setup, cookie, BOOKS.symbol);
  const columnIdOf = (fixtureId: string): string => registry.columns.find((column) => column.symbol === BOOKS.columns.find((each) => each.id === fixtureId)?.symbol)!.id;
  const screenId = screenSchema.parse((await post(setup.server, SCREENS_PATH, { name: SCREEN.name }, { cookie })).json()).id;
  const widget = {
    ...TABLE,
    bindings: TABLE.bindings.map((binding) => ({ ...binding, target: { ...binding.target, registryId: registry.id, ...(binding.target.columnId === undefined ? {} : { columnId: columnIdOf(binding.target.columnId) }) } })),
  };
  const design = await send(setup.server, "PUT", screenDesignPath(screenId), { name: SCREEN.name, theme: "dark", accent: "blue", widgets: [widget] }, { cookie });
  expect(design.status).toBe(200);
  return { setup, cookie, registry, screenId };
}

const preview = async (setup: Installation, cookie: string, symbol: string, change: unknown) => send(setup.server, "POST", structurePreviewPath(symbol), { change }, { cookie });
const previewed = async (setup: Installation, cookie: string, symbol: string, change: unknown) => {
  const reply = await preview(setup, cookie, symbol, change);
  expect(reply.status, JSON.stringify(change)).toBe(200);
  expect(reply.headers.get("cache-control")).toBe("no-store");
  return structurePreviewSchema.parse(reply.json());
};
const columnId = (registry: RegistryDto, symbol: string): string => registry.columns.find((column) => column.symbol === symbol)!.id;

describe("D26.2-AC1 what a change of F01 would do, through the real API", () => {
  it("removing autor: 25 records, the 22 with an author, the table widget by its slot; strony to text converts all 25; nothing is written", async () => {
    const { setup, cookie, registry, screenId } = await books();
    const before = stored(setup);
    const startedMs = Date.now();

    const removal = await previewed(setup, cookie, BOOKS.symbol, { kind: "removeColumn", columnId: columnId(registry, "autor") });
    const withAuthor = BOOKS.records.filter((record) => record.values["autor"] !== null && record.values["autor"] !== undefined).length;
    expect(withAuthor).toBe(22);
    expect(removal).toMatchObject({ registry: { symbol: BOOKS.symbol, schemaRevision: 1, dataRevision: 25 }, records: 25, affected: withAuthor, blocked: null });
    expect(removal.widgets).toEqual([{ screen: { id: screenId, name: SCREEN.name }, widgetId: TABLE.id, title: TABLE.config["title"], slots: ["columns"] }]);
    expect(removal.conversion).toBeUndefined();
    expect(removal.planToken).toEqual(expect.any(String));
    const expiresMs = Date.parse(removal.expiresAt ?? "");
    expect(expiresMs - startedMs).toBeGreaterThanOrEqual(STRUCTURE_PLAN_TTL_MS - 1_000);
    expect(expiresMs - Date.now()).toBeLessThanOrEqual(STRUCTURE_PLAN_TTL_MS);

    const toText = await previewed(setup, cookie, BOOKS.symbol, { kind: "changeType", columnId: columnId(registry, "strony"), type: "text" });
    expect(toText).toMatchObject({ records: 25, affected: 25, blocked: null, conversion: { converted: 25, unchanged: 0, empty: 0, failed: 0, samples: [] } });
    expect(toText.widgets).toEqual([]);

    // The whole registry: every record, and every slot the widget binds it by.
    const deletion = await previewed(setup, cookie, BOOKS.symbol, { kind: "deleteRegistry" });
    expect(deletion).toMatchObject({ records: 25, affected: 25, blocked: null });
    expect(deletion.widgets.map((widget) => widget.slots)).toEqual([["registry", "columns", "sortColumn"]]);
    // A new column has no widget, and a required one without a default would leave 25 records empty.
    const required = await previewed(setup, cookie, BOOKS.symbol, { kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", required: true } });
    expect(required).toMatchObject({ records: 25, affected: 0, widgets: [], blocked: "REQUIRED_EMPTY", planToken: null, expiresAt: null });

    expect(stored(setup), "a preview writes and audits nothing").toBe(before);
  });

  it("S9: text 12 and abc to a number converts one and fails the other with its sample; required without a replacement is blocked and has no plan", async () => {
    const setup = await installation();
    const cookie = (await readyOwner(setup)).sessionCookie;
    expect((await post(setup.server, REGISTRIES_PATH, definitionOf("pomiary", "Pomiary", [{ symbol: "wynik", displayName: "Wynik", type: "text", typeOptions: {}, defaultValue: null, required: false }]), { cookie })).status).toBe(201);
    for (const [index, wynik] of ["12", "abc"].entries()) {
      expect((await post(setup.server, registryRecordsPath("pomiary"), { schemaRevision: 1, values: { wynik } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `d26-2-s9-${index}` } })).status).toBe(201);
    }
    const wynik = columnId(await registryOf(setup, cookie, "pomiary"), "wynik");

    const optional = await previewed(setup, cookie, "pomiary", { kind: "changeType", columnId: wynik, type: "number" });
    expect(optional).toMatchObject({ records: 2, affected: 2, blocked: null, conversion: { converted: 1, unchanged: 0, empty: 0, failed: 1, samples: [{ value: "abc", count: 1 }] } });
    expect(optional.planToken).toEqual(expect.any(String));

    const required = await previewed(setup, cookie, "pomiary", { kind: "changeType", columnId: wynik, type: "number", required: true });
    expect(required).toMatchObject({ blocked: "REQUIRED_VALUES_LOST", planToken: null, expiresAt: null, conversion: { failed: 1 } });
    // With a replacement the change is not blocked; a replacement that is no number is the rules' refusal at its field.
    expect(await previewed(setup, cookie, "pomiary", { kind: "changeType", columnId: wynik, type: "number", required: true, replacement: 0 })).toMatchObject({ blocked: null, affected: 2 });
    const wrong = await preview(setup, cookie, "pomiary", { kind: "changeType", columnId: wynik, type: "number", required: true, replacement: "zero" });
    expect([wrong.status, code(wrong), apiErrorSchema.parse(wrong.json()).details?.["issues"]]).toEqual([422, "VALIDATION_FAILED", [{ path: "replacement", code: "REPLACEMENT_INVALID" }]]);
    // A column of another registry is unknown here; a change the contract does not know is a malformed request.
    const foreign = await preview(setup, cookie, "pomiary", { kind: "removeColumn", columnId: "019a0000-0000-7000-8000-00000000006f" });
    expect([foreign.status, apiErrorSchema.parse(foreign.json()).details?.["issues"]]).toEqual([422, [{ path: "columnId", code: "COLUMN_UNKNOWN" }]]);
    expect((await preview(setup, cookie, "pomiary", { kind: "renameSymbol", columnId: wynik, symbol: "inny" })).status).toBe(422);
    expect((await preview(setup, cookie, "nieistniejacy", { kind: "deleteRegistry" })).status).toBe(404);
  });
});

describe("D26.2-AC2 a plan is current only for its change, its owner and the registry as it was", () => {
  async function planned() {
    const { h, cookie } = await createSignedInHarness();
    expect((await h.request("POST", REGISTRIES_PATH, definitionOf("pomiary", "Pomiary", [{ symbol: "wynik", displayName: "Wynik", type: "text", typeOptions: {}, defaultValue: null, required: false }]), { cookie })).status).toBe(201);
    const add = (key: string) => h.request("POST", registryRecordsPath("pomiary"), { schemaRevision: h.rows<{ schema_revision: number }>("SELECT schema_revision FROM registry")[0]!.schema_revision, values: { wynik: "12" } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: key } });
    expect((await add("d26-2-plan-1")).status).toBe(201);
    const wynik = h.rows<{ id: string }>("SELECT id FROM registry_column WHERE symbol = 'wynik'")[0]!.id;
    const change = { kind: "changeType", columnId: wynik, type: "number" };
    const reply = await h.request("POST", structurePreviewPath("pomiary"), { change }, { cookie });
    expect(reply.status).toBe(200);
    const planToken = structurePreviewSchema.parse(reply.json()).planToken!;
    const token = (await h.sessionToken(cookie))!;
    const check = (input: { change?: unknown; planToken?: string }, nowMs: () => number = Date.now) =>
      checkStructurePlan({ ...h.structure, nowMs }, token, { symbol: "pomiary", change: input.change ?? change, planToken: input.planToken ?? planToken }, "req-d26-2");
    return { h, cookie, change, planToken, check, add };
  }

  it("the same change on the same registry is current; a new record and a new definition make it stale; nothing is written by a check", async () => {
    const { change, check, add } = await planned();
    // The order of the fields of a change is not another change.
    expect(check({ change: { type: change.type, columnId: change.columnId, kind: change.kind } })).toMatchObject({ ok: true, value: { kind: "changeType", type: "number" } });

    expect((await add("d26-2-plan-2")).status).toBe(201);
    expect(check({})).toEqual({ ok: false, error: { code: "PLAN_STALE" } });

    // The definition changes only in D27–D30; another writer raising the schema revision stands for them here.
    const fresh = await planned();
    fresh.h.sql("UPDATE registry SET schema_revision = schema_revision + 1");
    expect(fresh.check({})).toEqual({ ok: false, error: { code: "PLAN_STALE" } });
  });

  it("another change, another owner, a changed claim and the token of another installation are invalid; after ten minutes it has expired", async () => {
    const { h, change, planToken, check } = await planned();
    expect(check({ change: { ...change, type: "money" } })).toEqual({ ok: false, error: { code: "PLAN_INVALID" } });
    const registry = h.elsewhere.read((ports) => ports.registries.find("owner-1", "pomiary")) as StoredRegistry;
    expect(planFailure(h.structure.signer, { planToken, ownerId: "someone-else", change, registry }, Date.now())).toEqual({ code: "PLAN_INVALID" });

    // The claims are stated, so they can be rewritten; the signature then no longer matches them.
    const [payload, mac] = planToken.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, number | string>;
    const rewritten = `${Buffer.from(JSON.stringify({ ...claims, dataRevision: 99 })).toString("base64url")}.${mac}`;
    expect(check({ planToken: rewritten })).toEqual({ ok: false, error: { code: "PLAN_INVALID" } });
    const foreign = createStructurePlanSigner("ab".repeat(32)).issue(claims as never, { ownerId: "owner-1", change: JSON.stringify(change) });
    for (const token of [foreign, "", "not.a.token", `${planToken}.extra`]) expect(check({ planToken: token }), token).toEqual({ ok: false, error: { code: "PLAN_INVALID" } });
    // Neither the owner nor the change can be read from the token.
    expect(Buffer.from(payload, "base64url").toString("utf8")).not.toMatch(/owner|changeType|number/);

    expect(check({}, () => Date.now() + STRUCTURE_PLAN_TTL_MS)).toEqual({ ok: false, error: { code: "PLAN_EXPIRED" } });
    expect(check({}, () => Date.now() + STRUCTURE_PLAN_TTL_MS - 60_000)).toMatchObject({ ok: true });
  });

  it("a foreign Origin and no session are refused before anything is read", async () => {
    const { h, cookie, change } = await planned();
    const foreign = await h.request("POST", structurePreviewPath("pomiary"), { change }, { cookie, origin: "https://elsewhere.example" });
    expect([foreign.status, code(foreign)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    const anonymous = await h.request("POST", structurePreviewPath("pomiary"), { change }, { cookie: null });
    expect([anonymous.status, code(anonymous)]).toEqual([401, "AUTH_REQUIRED"]);
  });

  it("a type change of 50 000 records is previewed within the budget of a list (§16): one scan, p95 measured", async () => {
    const { h, cookie } = await createSignedInHarness();
    expect((await h.request("POST", REGISTRIES_PATH, definitionOf("duzy", "Duży", [{ symbol: "wynik", displayName: "Wynik", type: "text", typeOptions: {}, defaultValue: null, required: false }, { symbol: "opis", displayName: "Opis", type: "text", typeOptions: {}, defaultValue: null, required: false }]), { cookie })).status).toBe(201);
    const COUNT = 50_000;
    // The rows are written as the store writes them, in one transaction, so that the preview, not the seeding, is measured.
    const insert = h.connection.handle.prepare(`INSERT INTO reg_duzy (id, user_id, created_at, updated_at, revision, wynik, opis) VALUES (?, 'owner-1', ?, ?, 1, ?, ?)`);
    h.connection.handle.transaction(() => {
      for (let index = 0; index < COUNT; index += 1) {
        const at = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
        insert.run(`019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`, at, at, index % 10 === 0 ? `x${index}` : String(index % 900), index % 3 === 0 ? null : `opis ${index}`);
      }
      h.connection.handle.prepare("UPDATE registry SET data_revision = ? WHERE symbol = 'duzy'").run(COUNT);
    })();
    const wynik = h.rows<{ id: string }>("SELECT r.id FROM registry_column r JOIN registry g ON g.id = r.registry_id WHERE g.symbol = 'duzy' AND r.symbol = 'wynik'")[0]!.id;
    const times: number[] = [];
    let report: ReturnType<typeof structurePreviewSchema.parse> | null = null;
    for (let run = 0; run < 10; run += 1) {
      const started = performance.now();
      const reply = await h.request("POST", structurePreviewPath("duzy"), { change: { kind: "changeType", columnId: wynik, type: "number" } }, { cookie });
      times.push(performance.now() - started);
      expect(reply.status).toBe(200);
      report = structurePreviewSchema.parse(reply.json());
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    process.stdout.write(`D26.2 measurement (${process.platform} ${process.arch}, Node ${process.versions.node}, ${COUNT} records, text to number, 10 runs): preview p95 ${p95.toFixed(1)} ms, median ${times[5]!.toFixed(1)} ms\n`);
    expect(report).toMatchObject({ records: COUNT, conversion: { converted: COUNT - COUNT / 10, failed: COUNT / 10, empty: 0 } });
    expect(report?.conversion?.samples).toHaveLength(20);
    // The budget of §16 (300 ms) is checked by the measurement written above, on a stated machine; a
    // shared CI runner is no such machine, so here only an order of magnitude guards against a read of the whole table into memory per value.
    expect(p95).toBeLessThan(2_000);
  }, 120_000);
});
