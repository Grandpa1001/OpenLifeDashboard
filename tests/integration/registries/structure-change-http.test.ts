// D28.2 — carrying out a change of a column over real HTTP on the built server (Scope §5.6, S8;
// Architektura §4.5, §4.6, §5.2, §5.5), on Książki of F01 and its table widget made through the API.
// AC1: the preview and then the removal of `autor` on its plan answer the new revision, and the table
//      widget needs a new binding until the owner binds the column again (S8); a required column with
//      a default fills the 25 records and `autor` added again is a new column; each change is one
//      operation of the gate, closed after it, and audited.
// AC2: a plan made stale by a record is 409 PLAN_STALE and writes nothing; a change of type and the
//      deletion of a registry are not taken by this route; a foreign Origin and no session are refused;
//      a session that ends after the route read it and before the writer's unit writes nothing.
import { readFileSync } from "node:fs";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath } from "@openlife/contracts/http/records";
import { structureChangedSchema, structurePath, structurePreviewPath, structurePreviewSchema } from "@openlife/contracts/http/registries";
import { screenDesignPath, screenPath, screenSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { post, query, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { BOOKS, booksOverApi, columnId, registryOf, SCREEN, stored, tableWidget } from "../../support/books-http.ts";
import { stateFile } from "../../support/database-fixtures.ts";
import { closeHarnesses } from "../../support/app-harness.ts";
import { createSignedInHarness } from "../../support/signed-in-harness.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const gate = (setup: Installation) => JSON.parse(readFileSync(stateFile(setup.instance), "utf8")) as { generation: number; activeOperation: unknown };

/** The preview of a change and its plan, as the owner's window will ask for them (D31). */
async function planOf(setup: Installation, cookie: string, change: unknown): Promise<string> {
  const reply = await send(setup.server, "POST", structurePreviewPath(BOOKS.symbol), { change }, { cookie });
  expect(reply.status, JSON.stringify(change)).toBe(200);
  const planToken = structurePreviewSchema.parse(reply.json()).planToken;
  if (planToken === null) throw new Error("the preview blocked the change");
  return planToken;
}
const carryOut = (setup: Installation, cookie: string | null, change: unknown, planToken: string, init: { origin?: string | null } = {}) =>
  send(setup.server, "POST", structurePath(BOOKS.symbol), { change, planToken }, { cookie, ...init });
const stateOfTable = async (setup: Installation, cookie: string, screenId: string) => {
  const screen = screenSchema.parse((await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json());
  return screen.widgets.find((widget) => widget.type === "register-table")?.state;
};

describe("D28.2-AC1 the changes of a column of F01 through the real API", () => {
  it("S8: autor removed on its plan answers revision 2, the widget needs a binding, and bound again it is ok; each change one operation of the gate", async () => {
    const { setup, cookie, registry, screenId } = await booksOverApi("d28-2");
    const generation = gate(setup).generation;
    expect(await stateOfTable(setup, cookie, screenId)).toBe("ok");

    const removal = { kind: "removeColumn", columnId: columnId(registry, "autor") };
    const removed = await carryOut(setup, cookie, removal, await planOf(setup, cookie, removal));
    expect(removed.status).toBe(200);
    expect(removed.headers.get("cache-control")).toBe("no-store");
    expect(structureChangedSchema.parse(removed.json())).toEqual({ registry: { symbol: BOOKS.symbol, schemaRevision: 2 }, columnId: columnId(registry, "autor"), affected: 0 });
    expect(gate(setup)).toMatchObject({ generation: generation + 1, activeOperation: null });
    expect(await stateOfTable(setup, cookie, screenId)).toBe("needs_rebinding");

    // The owner binds the slot to a column that exists: the widget is ok again.
    const after = await registryOf(setup, cookie, BOOKS.symbol);
    const widget = tableWidget(registry);
    const rebound = { ...widget, bindings: widget.bindings.map((binding) => (binding.target.columnId === columnId(registry, "autor") ? { ...binding, path: "Field.Register.ksiazki.cena", target: { ...binding.target, columnId: columnId(after, "cena") } } : binding)) };
    expect((await send(setup.server, "PUT", screenDesignPath(screenId), { name: SCREEN.name, theme: "dark", accent: "blue", widgets: [rebound] }, { cookie })).status).toBe(200);
    expect(await stateOfTable(setup, cookie, screenId)).toBe("ok");

    const required = { kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", typeOptions: {}, defaultValue: 5, required: true } };
    const added = await carryOut(setup, cookie, required, await planOf(setup, cookie, required));
    expect(structureChangedSchema.parse(added.json())).toMatchObject({ registry: { schemaRevision: 3 }, affected: 25 });
    expect(query(setup.instance, "SELECT DISTINCT ocena FROM reg_ksiazki")).toEqual([{ ocena: 5 }]);
    const again = { kind: "addColumn", column: { symbol: "autor", displayName: "Autor", type: "text", typeOptions: {}, defaultValue: null, required: false } };
    const readded = structureChangedSchema.parse((await carryOut(setup, cookie, again, await planOf(setup, cookie, again))).json());
    expect(readded.columnId).not.toBe(columnId(registry, "autor"));
    expect(columnId(await registryOf(setup, cookie, BOOKS.symbol), "autor")).toBe(readded.columnId);

    expect(gate(setup)).toEqual(expect.objectContaining({ generation: generation + 3, activeOperation: null }));
    expect(query<{ action: string }>(setup.instance, "SELECT action FROM audit_log WHERE action LIKE 'registry.column_%' ORDER BY rowid").map((row) => row.action)).toEqual(["registry.column_removed", "registry.column_added", "registry.column_added"]);
  });
});

describe("D28.2-AC2 what the route refuses", () => {
  it("a plan made stale by a record is 409 PLAN_STALE and writes nothing; a change of type and a deletion are not this route's; a foreign Origin and no session are refused", async () => {
    const { setup, cookie, registry } = await booksOverApi("d28-2-refusals");
    const rename = { kind: "renameColumn", columnId: columnId(registry, "strony"), displayName: "Liczba stron książki" };
    const planToken = await planOf(setup, cookie, rename);
    expect((await post(setup.server, registryRecordsPath(BOOKS.symbol), { schemaRevision: 1, values: { tytul: "Nowa" } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: "d28-2-stale-record" } })).status).toBe(201);
    const before = stored(setup);
    const generation = gate(setup).generation;

    const stale = await carryOut(setup, cookie, rename, planToken);
    expect([stale.status, code(stale)]).toEqual([409, "PLAN_STALE"]);
    expect(stored(setup)).toBe(before);
    // The plan was checked under the writer, inside an operation of the gate that then closed.
    expect(gate(setup)).toEqual(expect.objectContaining({ generation: generation + 1, activeOperation: null }));

    for (const change of [{ kind: "changeType", columnId: columnId(registry, "strony"), type: "text" }, { kind: "deleteRegistry" }]) {
      const refused = await carryOut(setup, cookie, change, planToken);
      expect([refused.status, code(refused)], change.kind).toEqual([422, "VALIDATION_FAILED"]);
    }
    const foreign = await carryOut(setup, cookie, rename, planToken, { origin: "https://elsewhere.example" });
    expect([foreign.status, code(foreign)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    const anonymous = await carryOut(setup, null, rename, planToken);
    expect([anonymous.status, code(anonymous)]).toEqual([401, "AUTH_REQUIRED"]);
    expect(stored(setup)).toBe(before);
    expect(gate(setup).generation).toBe(generation + 1);
  });

  it("a session that ends between the read of the route and the unit of the writer writes nothing, and the operation closes", async () => {
    const { h, cookie } = await createSignedInHarness();
    expect((await h.request("POST", "/api/v1/registries", { symbol: "waga", displayName: "Waga", columns: [{ symbol: "kg", displayName: "Kg", type: "number", typeOptions: {}, defaultValue: null, required: false }] }, { cookie })).status).toBe(201);
    const kg = h.rows<{ id: string }>("SELECT id FROM registry_column WHERE symbol = 'kg'")[0]!.id;
    const rename = { kind: "renameColumn", columnId: kg, displayName: "Kilogramy" };
    const planToken = structurePreviewSchema.parse((await h.request("POST", structurePreviewPath("waga"), { change: rename }, { cookie })).json()).planToken;
    const generation = h.gate.current().generation;
    const before = JSON.stringify([h.rows("SELECT * FROM registry"), h.rows("SELECT * FROM registry_column"), h.rows("SELECT * FROM audit_log WHERE action LIKE 'registry.%'")]);
    // The session ends elsewhere after the route has read it, just before the unit of the operation begins.
    h.interruptNextWrite(() => h.sql("DELETE FROM session"));
    const reply = await h.request("POST", structurePath("waga"), { change: rename, planToken }, { cookie });
    expect([reply.status, code({ json: reply.json })]).toEqual([401, "AUTH_REQUIRED"]);
    expect(JSON.stringify([h.rows("SELECT * FROM registry"), h.rows("SELECT * FROM registry_column"), h.rows("SELECT * FROM audit_log WHERE action LIKE 'registry.%'")])).toBe(before);
    expect(h.gate.current()).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
  });
});
