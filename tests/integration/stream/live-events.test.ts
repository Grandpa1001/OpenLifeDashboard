// D38.1 — the events of committed changes (Architektura §10, §7.6; Scope S11), on the in-process app
// of the harness with a listener on its hub: every route that writes tells the open streams what changed
// once the change is committed, and tells nothing when it refuses or wrote nothing.
// AC1: each write of the table below sends exactly one event with the field it names (a dictionary, one
//      per registry that uses it), and a refusal, a conflict and a repeated add send none.
// AC2: the event arrives after the commit (a read inside the listener already sees the change), and a
//      listener that fails neither changes the answer of the route nor stops the others.
import { IDEMPOTENCY_KEY_HEADER, registryRecordPath, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, structurePath, structurePreviewPath } from "@openlife/contracts/http/registries";
import { DICTIONARIES_PATH, dictionaryPath } from "@openlife/contracts/http/dictionaries";
import { CONFIG_PATH, configEntryPath } from "@openlife/contracts/http/config";
import { screenDesignPath, SCREENS_PATH } from "@openlife/contracts/http/screens";
import type { LiveEvent } from "@openlife/contracts/http/stream";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, type AppHarness, type HarnessOptions } from "../../support/app-harness.ts";
import { ownerSession } from "../../support/harness-owner.ts";

afterEach(closeHarnesses);

const NOTES = { symbol: "notatki", displayName: "Notatki", columns: [{ symbol: "tytul", displayName: "Tytuł", type: "text", typeOptions: {}, defaultValue: null, required: false }] };
const IDEMPOTENCY = "d38-1-add";

/** An owner who chose empty data, and the events the hub sends to a listener standing in for an open stream. */
async function listening(probe: (h: AppHarness) => unknown = () => null, options: HarnessOptions = {}) {
  const { h, cookie, chooseEmpty } = await ownerSession(options);
  await chooseEmpty();
  const events: Array<{ event: LiveEvent; seen: unknown }> = [];
  const subscribed = h.hub.subscribe({ sessionId: "probe", token: "probe", send: (event) => events.push({ event, seen: probe(h) }), close: () => undefined });
  expect(subscribed.accepted).toBe(true);
  const json = async (method: string, route: string, body?: unknown, headers?: Record<string, string>) => h.request(method, route, body, { cookie, ...(headers === undefined ? {} : { headers }) });
  /** The events the call sends, in order. */
  const during = async (call: () => Promise<{ status: number }>): Promise<{ status: number; events: LiveEvent[] }> => {
    const before = events.length;
    const reply = await call();
    return { status: reply.status, events: events.slice(before).map((each) => each.event) };
  };
  return { h, cookie, json, during, events };
}

describe("D38.1-AC1 what each write tells the streams", () => {
  it("a registry, its records, its structure, a dictionary, a config entry and a screen each send one event with the field that names them", async () => {
    const { json, during } = await listening();
    const created = await during(() => json("POST", REGISTRIES_PATH, NOTES));
    expect([created.status, created.events]).toEqual([201, [{ type: "schema.changed", registry: "notatki" }]]);

    const added = await json("POST", registryRecordsPath("notatki"), { schemaRevision: 1, values: { tytul: "Pierwsza" } }, { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY });
    expect(added.status).toBe(201);
    const record = added.json() as { id: string };
    const changed = await during(() => json("PATCH", registryRecordPath("notatki", record.id), { schemaRevision: 1, expectedRevision: 1, values: { tytul: "Zmieniona" } }));
    expect([changed.status, changed.events]).toEqual([200, [{ type: "data.changed", registry: "notatki" }]]);
    const removed = await during(() => json("DELETE", registryRecordPath("notatki", record.id), { expectedRevision: 2 }));
    expect([removed.status, removed.events]).toEqual([204, [{ type: "data.changed", registry: "notatki" }]]);

    const column = { kind: "addColumn", column: { symbol: "uwagi", displayName: "Uwagi", type: "text", typeOptions: {}, defaultValue: null, required: false } };
    const planToken = (((await json("POST", structurePreviewPath("notatki"), { change: column })).json()) as { planToken: string }).planToken;
    const restructured = await during(() => json("POST", structurePath("notatki"), { change: column, planToken }));
    expect([restructured.status, restructured.events]).toEqual([200, [{ type: "schema.changed", registry: "notatki" }]]);

    const entry = await during(() => json("POST", CONFIG_PATH, { symbol: "norma", displayName: "Norma", value: "20" }));
    expect([entry.status, entry.events]).toEqual([201, [{ type: "config.changed", symbol: "norma" }]]);
    const saved = await during(() => json("PUT", configEntryPath("norma"), { expectedRevision: 1, displayName: "Norma", value: "25" }));
    expect([saved.status, saved.events]).toEqual([200, [{ type: "config.changed", symbol: "norma" }]]);
    const dropped = await during(() => json("DELETE", configEntryPath("norma"), { expectedRevision: 2 }));
    expect([dropped.status, dropped.events]).toEqual([200, [{ type: "config.changed", symbol: "norma" }]]);

    const screen = await during(() => json("POST", SCREENS_PATH, { name: "Pulpit" }));
    expect([screen.status, screen.events.map((event) => event.type)]).toEqual([201, ["layout.changed"]]);
    const screenId = (screen.events[0] as { screenId: string }).screenId;
    const designed = await during(() => json("PUT", screenDesignPath(screenId), { name: "Pulpit", theme: "dark", accent: "blue", widgets: [] }));
    expect([designed.status, designed.events]).toEqual([200, [{ type: "layout.changed", screenId }]]);
  });

  it("a dictionary tells the registries that use it, once each, and one that nothing uses tells nobody", async () => {
    const { json, during } = await listening();
    const created = await during(() => json("POST", DICTIONARIES_PATH, { symbol: "status", displayName: "Status", values: [{ symbol: "nowa", label: "Nowa", hidden: false }] }));
    expect([created.status, created.events]).toEqual([201, []]);
    const dictionaryId = ((await json("GET", dictionaryPath("status"))).json() as { id: string }).id;
    const withChoice = (symbol: string) => ({ symbol, displayName: symbol, columns: ["a", "b"].map((name) => ({ symbol: name, displayName: name, type: "choice", typeOptions: { dictionaryId }, defaultValue: null, required: false })) });
    await json("POST", REGISTRIES_PATH, withChoice("jeden"));
    await json("POST", REGISTRIES_PATH, withChoice("dwa"));

    const saved = await during(() => json("PUT", dictionaryPath("status"), { expectedRevision: 1, displayName: "Stan", values: [{ symbol: "nowa", label: "Świeża", hidden: false }] }));
    expect(saved.status).toBe(200);
    expect(saved.events.map((event) => event.type)).toEqual(["schema.changed", "schema.changed"]);
    expect(saved.events.map((event) => (event as { registry: string }).registry).sort()).toEqual(["dwa", "jeden"]);

    const lonely = await json("POST", DICTIONARIES_PATH, { symbol: "pusty", displayName: "Pusty", values: [] });
    expect(lonely.status).toBe(201);
    const unused = await during(() => json("PUT", dictionaryPath("pusty"), { expectedRevision: 1, displayName: "Pusty 2", values: [] }));
    expect([unused.status, unused.events]).toEqual([200, []]);

    const deleted = await during(() => json("DELETE", dictionaryPath("status"), { expectedRevision: 2 }));
    expect(deleted.status).toBe(200);
    expect(deleted.events.map((event) => (event as { registry: string }).registry).sort()).toEqual(["dwa", "jeden"]);
  });

  it("a refusal, a stale revision and an add repeated with the same key send nothing", async () => {
    const { json, during, events } = await listening();
    await json("POST", REGISTRIES_PATH, NOTES);
    const key = { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY };
    const first = await during(() => json("POST", registryRecordsPath("notatki"), { schemaRevision: 1, values: { tytul: "Raz" } }, key));
    expect([first.status, first.events]).toEqual([201, [{ type: "data.changed", registry: "notatki" }]]);
    const record = (await json("GET", `${registryRecordsPath("notatki")}?pageSize=10`)).json() as { records: Array<{ id: string }> };

    const sent = events.length;
    const repeated = await json("POST", registryRecordsPath("notatki"), { schemaRevision: 1, values: { tytul: "Raz" } }, key);
    expect(repeated.status).toBe(200);
    const stale = await json("PATCH", registryRecordPath("notatki", record.records[0]!.id), { schemaRevision: 1, expectedRevision: 7, values: { tytul: "X" } });
    expect(stale.status).toBe(409);
    const invalid = await json("POST", registryRecordsPath("notatki"), { schemaRevision: 1, values: { nieznana: 1 } }, { [IDEMPOTENCY_KEY_HEADER]: "d38-1-invalid" });
    expect(invalid.status).toBe(422);
    const unknown = await json("PUT", screenDesignPath("019a0000-0000-7000-8000-0000000d3801"), { name: "X", theme: "dark", accent: "blue", widgets: [] });
    expect(unknown.status).toBe(404);
    const foreign = await listening();
    const crossOrigin = await foreign.h.request("POST", REGISTRIES_PATH, NOTES, { cookie: foreign.cookie, origin: "https://elsewhere.example" });
    expect(crossOrigin.status).toBe(403);
    expect(events.length).toBe(sent);
    expect(foreign.events).toEqual([]);
  });
});

describe("D38.1-AC2 after the commit, and a listener that fails", () => {
  it("a read inside the listener already sees what the event tells of", async () => {
    const { json, events } = await listening((h) => h.rows<{ n: number }>("SELECT count(*) AS n FROM reg_notatki")[0]?.n ?? null);
    await json("POST", REGISTRIES_PATH, NOTES);
    events.length = 0;
    await json("POST", registryRecordsPath("notatki"), { schemaRevision: 1, values: { tytul: "Widoczna" } }, { [IDEMPOTENCY_KEY_HEADER]: IDEMPOTENCY });
    expect(events).toEqual([{ event: { type: "data.changed", registry: "notatki" }, seen: 1 }]);
  });

  it("a stream that cannot be written to is dropped, the others still get the event and the route still answers", async () => {
    const { h, json, events } = await listening();
    const broken = h.hub.subscribe({ sessionId: "broken", token: "broken", send: () => { throw new Error("socket closed"); }, close: () => undefined });
    expect(broken.accepted).toBe(true);
    const created = await json("POST", REGISTRIES_PATH, NOTES);
    expect(created.status).toBe(201);
    expect(events.map((each) => each.event)).toEqual([{ type: "schema.changed", registry: "notatki" }]);
    expect(h.hub.count("broken")).toBe(0);
  });

  it("an announcement that throws is logged and the change is still answered as made", async () => {
    const { h, json } = await listening(() => null, {
      announce: () => {
        throw new Error("hub failed");
      },
    });
    const created = await json("POST", REGISTRIES_PATH, NOTES);
    expect(created.status).toBe(201);
    expect(h.logLines().some((line) => line.includes("live.announce_failed"))).toBe(true);
  });
});
