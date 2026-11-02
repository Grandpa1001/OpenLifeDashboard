// D29.2 — a change of type carried out over real HTTP on the built server, after its copy
// `pre_type_change` (Scope §5.6, S9; Architektura §4.5, §4.6, §5.2, §11.3.1).
// AC1: S9 through the API: the preview reports 12 and abc, carrying it out answers 200 with `failed`
//      equal to the report and the ID of a published copy `pre_type_change`, and the records hold 12 and
//      an empty cell; a required column is blocked without a replacement and takes it with one; F01
//      `strony` number → text converts its 25 records.
// AC2: a copy that cannot be made is 503 with the registry unchanged; a stale plan is 409 PLAN_STALE; a
//      second change while an operation is active is 503 MAINTENANCE; a session that ends before the
//      unit writes nothing (the copy may be published); a foreign Origin and no session are refused.
import { chmodSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { databaseSnapshotMetaSchema } from "@openlife/contracts/backups/database-snapshot";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, structureChangedSchema, structurePath, structurePreviewPath, structurePreviewSchema } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { installation, post, query, readyOwner, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { BOOKS, booksOverApi, columnId, registryOf, stored } from "../../support/books-http.ts";
import { closeHarnesses } from "../../support/app-harness.ts";
import { backupsDir, packages, stateFile } from "../../support/database-fixtures.ts";
import { createSignedInHarness } from "../../support/signed-in-harness.ts";

afterEach(async () => {
  closeHarnesses();
  await stopServers();
});

const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const gate = (setup: Installation) => JSON.parse(readFileSync(stateFile(setup.instance), "utf8")) as { generation: number; activeOperation: unknown };
const column = (required: boolean) => ({ symbol: "wynik", displayName: "Wynik", type: "text", typeOptions: {}, defaultValue: null, required });

/** `pomiary` with a text column holding 12 and abc (F03), made through the API of the built server. */
async function measurements(keyPrefix: string, required = false): Promise<{ setup: Installation; cookie: string; columnId: string }> {
  const setup = await installation();
  const cookie = (await readyOwner(setup)).sessionCookie;
  expect((await post(setup.server, REGISTRIES_PATH, { symbol: "pomiary", displayName: "Pomiary", columns: [column(required)] }, { cookie })).status).toBe(201);
  for (const [index, wynik] of ["12", "abc"].entries()) {
    expect((await post(setup.server, registryRecordsPath("pomiary"), { schemaRevision: 1, values: { wynik } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `${keyPrefix}-add-${index}` } })).status).toBe(201);
  }
  return { setup, cookie, columnId: columnId(await registryOf(setup, cookie, "pomiary"), "wynik") };
}

const preview = async (setup: Installation, cookie: string, symbol: string, change: unknown) => {
  const reply = await send(setup.server, "POST", structurePreviewPath(symbol), { change }, { cookie });
  expect(reply.status, JSON.stringify(change)).toBe(200);
  return structurePreviewSchema.parse(reply.json());
};
const carryOut = (setup: Installation, cookie: string | null, symbol: string, change: unknown, planToken: string, init: { origin?: string | null } = {}) =>
  send(setup.server, "POST", structurePath(symbol), { change, planToken }, { cookie, ...init });
const metaOf = (pkg: string) => databaseSnapshotMetaSchema.parse(JSON.parse(readFileSync(path.join(pkg, "meta.json"), "utf8")));

describe("D29.2-AC1 a change of type through the real API, after its copy", () => {
  it("S9: 12 and abc to a number answer failed 1 as reported, name a published copy pre_type_change, and leave 12 and an empty cell", async () => {
    const { setup, cookie, columnId: wynik } = await measurements("d29-2");
    const generation = gate(setup).generation;
    const change = { kind: "changeType", columnId: wynik, type: "number" };
    const report = await preview(setup, cookie, "pomiary", change);
    expect(report.conversion).toMatchObject({ converted: 1, failed: 1, samples: [{ value: "abc", count: 1 }] });

    const reply = await carryOut(setup, cookie, "pomiary", change, report.planToken!);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    const changed = structureChangedSchema.parse(reply.json());
    expect(changed).toEqual({ registry: { symbol: "pomiary", schemaRevision: 2 }, columnId: wynik, affected: 2, failed: report.conversion!.failed, snapshotId: expect.any(String) });
    const [pkg, ...others] = packages(setup.instance);
    expect(others).toEqual([]);
    expect(metaOf(pkg!)).toMatchObject({ snapshotId: changed.snapshotId, reason: "pre_type_change" });
    expect(query(setup.instance, "SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: 12 }, { wynik: null }]);
    expect((await registryOf(setup, cookie, "pomiary")).columns[0]).toMatchObject({ id: wynik, type: "number" });
    expect(gate(setup)).toMatchObject({ generation: generation + 1, activeOperation: null });
    expect(query<{ action: string }>(setup.instance, "SELECT action FROM audit_log WHERE action LIKE 'registry.column_%'").map((row) => row.action)).toEqual(["registry.column_type_changed"]);
  });

  it("a required column: blocked without a replacement and no plan; with a replacement abc takes it and failed stays 1", async () => {
    const { setup, cookie, columnId: wynik } = await measurements("d29-2-required", true);
    const blocked = await preview(setup, cookie, "pomiary", { kind: "changeType", columnId: wynik, type: "number", required: true });
    expect([blocked.blocked, blocked.planToken]).toEqual(["REQUIRED_VALUES_LOST", null]);
    expect(packages(setup.instance)).toEqual([]);

    const change = { kind: "changeType", columnId: wynik, type: "number", required: true, replacement: 0 };
    const report = await preview(setup, cookie, "pomiary", change);
    const changed = structureChangedSchema.parse((await carryOut(setup, cookie, "pomiary", change, report.planToken!)).json());
    expect(changed).toMatchObject({ registry: { schemaRevision: 2 }, affected: 2, failed: 1 });
    expect(query(setup.instance, "SELECT wynik FROM reg_pomiary ORDER BY id")).toEqual([{ wynik: 12 }, { wynik: 0 }]);
  });

  it("F01: strony from a number to text converts the 25 records with nothing failed", async () => {
    const { setup, cookie, registry } = await booksOverApi("d29-2-books");
    const change = { kind: "changeType", columnId: columnId(registry, "strony"), type: "text" };
    const report = await preview(setup, cookie, BOOKS.symbol, change);
    const changed = structureChangedSchema.parse((await carryOut(setup, cookie, BOOKS.symbol, change, report.planToken!)).json());
    expect(changed).toMatchObject({ registry: { symbol: BOOKS.symbol, schemaRevision: 2 }, affected: report.affected, failed: 0 });
    expect(query<{ n: number }>(setup.instance, "SELECT count(*) AS n FROM reg_ksiazki WHERE typeof(strony) = 'text'")).toEqual([{ n: 25 }]);
  });
});

describe("D29.2-AC2 what stops a change of type", () => {
  it("a copy that cannot be made is 503 SNAPSHOT_FAILED with nothing changed; a stale plan is 409 PLAN_STALE; a foreign Origin and no session are refused", async () => {
    const { setup, cookie, columnId: wynik } = await measurements("d29-2-refused");
    const change = { kind: "changeType", columnId: wynik, type: "number" };
    const report = await preview(setup, cookie, "pomiary", change);
    const before = stored(setup);
    const generation = gate(setup).generation;

    // The folder of copies cannot take the staging of a new one.
    chmodSync(backupsDir(setup.instance), 0o500);
    let failed;
    try {
      failed = await carryOut(setup, cookie, "pomiary", change, report.planToken!);
    } finally {
      chmodSync(backupsDir(setup.instance), 0o700);
    }
    expect([failed.status, code(failed)]).toEqual([503, "SNAPSHOT_FAILED"]);
    expect(stored(setup)).toBe(before);
    expect(readdirSync(backupsDir(setup.instance))).toEqual([]);
    expect(gate(setup)).toMatchObject({ generation: generation + 1, activeOperation: null });

    expect((await post(setup.server, registryRecordsPath("pomiary"), { schemaRevision: 1, values: { wynik: "7" } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: "d29-2-stale" } })).status).toBe(201);
    const afterRecord = stored(setup);
    const stale = await carryOut(setup, cookie, "pomiary", change, report.planToken!);
    expect([stale.status, code(stale)]).toEqual([409, "PLAN_STALE"]);
    expect(stored(setup)).toBe(afterRecord);

    const foreign = await carryOut(setup, cookie, "pomiary", change, report.planToken!, { origin: "https://elsewhere.example" });
    expect([foreign.status, code(foreign)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    const anonymous = await carryOut(setup, null, "pomiary", change, report.planToken!);
    expect([anonymous.status, code(anonymous)]).toEqual([401, "AUTH_REQUIRED"]);
    expect(stored(setup)).toBe(afterRecord);
  });

  it("an active operation is 503 MAINTENANCE; a session that ends after the copy writes nothing and the operation closes", async () => {
    const { h, cookie } = await createSignedInHarness();
    expect((await h.request("POST", REGISTRIES_PATH, { symbol: "pomiary", displayName: "Pomiary", columns: [column(false)] }, { cookie })).status).toBe(201);
    const wynik = h.rows<{ id: string }>("SELECT id FROM registry_column WHERE symbol = 'wynik'")[0]!.id;
    const change = { kind: "changeType", columnId: wynik, type: "number" };
    const planToken = structurePreviewSchema.parse((await h.request("POST", structurePreviewPath("pomiary"), { change }, { cookie })).json()).planToken;
    const catalog = () => JSON.stringify([h.rows("SELECT * FROM registry"), h.rows("SELECT * FROM registry_column"), h.rows("SELECT sql FROM sqlite_master ORDER BY name"), h.rows("SELECT * FROM audit_log WHERE action LIKE 'registry.%'")]);
    const before = catalog();

    // Another operation holds the gate (an upgrade, another change): this one does not begin.
    const operationId = randomUUID();
    const held = h.gate.begin({ operationId, reason: "snapshot", phase: "staging", startedAt: new Date().toISOString(), snapshotId: "held" });
    const busy = await h.request("POST", structurePath("pomiary"), { change, planToken }, { cookie });
    expect([busy.status, code({ json: busy.json })]).toEqual([503, "MAINTENANCE"]);
    h.gate.complete(operationId, held.generation);

    // The session ends after the copy and before the unit of the rebuild.
    const generation = h.gate.current().generation;
    h.interruptNextWrite(() => h.sql("DELETE FROM session"));
    const ended = await h.request("POST", structurePath("pomiary"), { change, planToken }, { cookie });
    expect([ended.status, code({ json: ended.json })]).toEqual([401, "AUTH_REQUIRED"]);
    expect(catalog()).toBe(before);
    expect(h.gate.current()).toEqual({ formatVersion: 1, generation: generation + 1, activeOperation: null });
    // The copy was made before the session was read again; it stays, as any copy does.
    expect(readdirSync(h.backupsDir).filter((name) => !name.startsWith("."))).toHaveLength(1);
  });
});
