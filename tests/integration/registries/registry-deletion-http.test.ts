// D30.1 — the deletion of a registry over real HTTP on the built server, after its copy `pre_delete`
// (Scope §5.6, S10; Architektura §4.5, §4.6, §5.2, §11.3.1), on Książki of F01 and its table widget
// made through the API.
// AC1: the preview counts the 25 records and the widget; carrying the deletion out answers revision 2,
//      no column, the 25 records and the ID of a published copy pre_delete that still holds the table and
//      its records; the table is gone, the catalog marks the registry deleted, the list, the records and
//      the preview no longer have it, its symbol stays taken, the widget needs a binding (S10), the
//      audit has no values and the gate is closed.
// AC2: a copy that cannot be made is 503 with nothing changed; a stale plan is 409; a foreign Origin and
//      no session are refused; a session that ends after the copy deletes nothing.
import { chmodSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { databaseSnapshotMetaSchema } from "@openlife/contracts/backups/database-snapshot";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, registryListSchema, structureChangedSchema, structurePath, structurePreviewPath, structurePreviewSchema } from "@openlife/contracts/http/registries";
import { screenPath, screenSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { post, query, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { BOOKS, booksOverApi, definitionOf, stored } from "../../support/books-http.ts";
import { closeHarnesses } from "../../support/app-harness.ts";
import { backupsDir, packages, restoredRows, stateFile } from "../../support/database-fixtures.ts";
import { createSignedInHarness } from "../../support/signed-in-harness.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

const DELETION = { kind: "deleteRegistry" };
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const gate = (setup: Installation) => JSON.parse(readFileSync(stateFile(setup.instance), "utf8")) as { generation: number; activeOperation: unknown };
const previewOf = async (setup: Installation, cookie: string) => {
  const reply = await send(setup.server, "POST", structurePreviewPath(BOOKS.symbol), { change: DELETION }, { cookie });
  expect(reply.status).toBe(200);
  return structurePreviewSchema.parse(reply.json());
};
const carryOut = (setup: Installation, cookie: string | null, planToken: string, init: { origin?: string | null } = {}) =>
  send(setup.server, "POST", structurePath(BOOKS.symbol), { change: DELETION, planToken }, { cookie, ...init });
const tables = (setup: Installation) => query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master WHERE tbl_name = 'reg_ksiazki' ORDER BY name").map((row) => row.name);

describe("D30.1-AC1 the deletion of Książki through the real API, after its copy", () => {
  it("S10: the copy pre_delete holds the 25 records, the table is gone, the symbol stays taken and the widget needs a binding", async () => {
    const { setup, cookie, screenId } = await booksOverApi("d30-1");
    const generation = gate(setup).generation;
    const preview = await previewOf(setup, cookie);
    expect(preview).toMatchObject({ records: 25, affected: 25, blocked: null });
    expect(preview.widgets).toHaveLength(1);
    expect(tables(setup).length).toBeGreaterThan(1);

    const reply = await carryOut(setup, cookie, preview.planToken!);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    const deleted = structureChangedSchema.parse(reply.json());
    expect(deleted).toEqual({ registry: { symbol: BOOKS.symbol, schemaRevision: 2 }, columnId: null, affected: 25, snapshotId: expect.any(String) });

    const [pkg, ...others] = packages(setup.instance);
    expect(others).toEqual([]);
    expect(databaseSnapshotMetaSchema.parse(JSON.parse(readFileSync(path.join(pkg!, "meta.json"), "utf8")))).toMatchObject({ snapshotId: deleted.snapshotId, reason: "pre_delete" });
    expect(restoredRows(pkg!, "SELECT count(*) AS n FROM reg_ksiazki")).toEqual([{ n: 25 }]);
    expect(restoredRows(pkg!, "SELECT deleted_at FROM registry WHERE symbol = 'ksiazki'")).toEqual([{ deleted_at: null }]);

    // The table and its indexes are gone; the rows of the catalog stay, marked deleted.
    expect(tables(setup)).toEqual([]);
    expect(query(setup.instance, "SELECT schema_revision, deleted_at IS NOT NULL AS deleted FROM registry WHERE symbol = 'ksiazki'")).toEqual([{ schema_revision: 2, deleted: 1 }]);
    expect(query<{ n: number }>(setup.instance, "SELECT count(*) AS n FROM registry_column c JOIN registry r ON r.id = c.registry_id WHERE r.symbol = 'ksiazki'")[0]!.n).toBe(BOOKS.columns.length);

    const list = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie })).json());
    expect(list.registries.map((registry) => registry.symbol)).toEqual([]);
    const records = await send(setup.server, "GET", registryRecordsPath(BOOKS.symbol), undefined, { cookie });
    expect([records.status, code(records)]).toEqual([404, "NOT_FOUND"]);
    const again = await send(setup.server, "POST", structurePreviewPath(BOOKS.symbol), { change: DELETION }, { cookie });
    expect([again.status, code(again)]).toEqual([404, "NOT_FOUND"]);
    const recreated = await post(setup.server, REGISTRIES_PATH, definitionOf(BOOKS.symbol, BOOKS.displayName, BOOKS.columns), { cookie });
    expect([recreated.status, code(recreated)]).toEqual([409, "REGISTRY_SYMBOL_TAKEN"]);

    const screen = screenSchema.parse((await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json());
    expect(screen.widgets.find((widget) => widget.type === "register-table")?.state).toBe("needs_rebinding");
    const audit = query<{ details: string }>(setup.instance, "SELECT details FROM audit_log WHERE action = 'registry.deleted'");
    expect(audit.map((row) => JSON.parse(row.details))).toEqual([{ registry: BOOKS.symbol, records: 25, columns: BOOKS.columns.length }]);
    expect(gate(setup)).toMatchObject({ generation: generation + 1, activeOperation: null });
  });
});

describe("D30.1-AC2 what stops a deletion", () => {
  it("a copy that cannot be made is 503 with nothing changed; a stale plan is 409; a foreign Origin and no session are refused", async () => {
    const { setup, cookie } = await booksOverApi("d30-1-refused");
    const preview = await previewOf(setup, cookie);
    const before = stored(setup);

    chmodSync(backupsDir(setup.instance), 0o500);
    let failed;
    try {
      failed = await carryOut(setup, cookie, preview.planToken!);
    } finally {
      chmodSync(backupsDir(setup.instance), 0o700);
    }
    expect([failed.status, code(failed)]).toEqual([503, "SNAPSHOT_FAILED"]);
    expect(stored(setup)).toBe(before);
    expect(readdirSync(backupsDir(setup.instance))).toEqual([]);

    expect((await post(setup.server, registryRecordsPath(BOOKS.symbol), { schemaRevision: 1, values: { tytul: "Nowa" } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: "d30-1-stale" } })).status).toBe(201);
    const afterRecord = stored(setup);
    const stale = await carryOut(setup, cookie, preview.planToken!);
    expect([stale.status, code(stale)]).toEqual([409, "PLAN_STALE"]);
    const foreign = await carryOut(setup, cookie, preview.planToken!, { origin: "https://elsewhere.example" });
    expect([foreign.status, code(foreign)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    const anonymous = await carryOut(setup, null, preview.planToken!);
    expect([anonymous.status, code(anonymous)]).toEqual([401, "AUTH_REQUIRED"]);
    expect(stored(setup)).toBe(afterRecord);
  });

  it("a session that ends after the copy deletes nothing and the operation closes", async () => {
    const { h, cookie } = await createSignedInHarness();
    expect((await h.request("POST", REGISTRIES_PATH, { symbol: "waga", displayName: "Waga", columns: [{ symbol: "kg", displayName: "Kg", type: "number", typeOptions: {}, defaultValue: null, required: false }] }, { cookie })).status).toBe(201);
    const planToken = structurePreviewSchema.parse((await h.request("POST", structurePreviewPath("waga"), { change: DELETION }, { cookie })).json()).planToken;
    const catalog = () => JSON.stringify([h.rows("SELECT * FROM registry"), h.rows("SELECT sql FROM sqlite_master ORDER BY name"), h.rows("SELECT * FROM audit_log WHERE action LIKE 'registry.%'")]);
    const before = catalog();
    const generation = h.gate.current().generation;

    h.interruptNextWrite(() => h.sql("DELETE FROM session"));
    const reply = await h.request("POST", structurePath("waga"), { change: DELETION, planToken }, { cookie });
    expect([reply.status, code({ json: reply.json })]).toEqual([401, "AUTH_REQUIRED"]);
    expect(catalog()).toBe(before);
    expect(h.gate.current()).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
    expect(readdirSync(h.backupsDir).filter((name) => !name.startsWith("."))).toHaveLength(1);
  });
});
