// D25.2 — ConfigTable over real HTTP on the built server (Scope §5.7, S17; Architektura §6, §9.5,
// §15), with the entry of F01 made through the API.
// AC1: norma_czytania = "20" is created, listed as the text "20" with no bindings, read, saved and
//      deleted; the audit of the database holds the old and the new value of every change, while the
//      technical log of the server, its output and every answer to a refusal hold no value at all.
// AC2: two saves of revision 1 are 200 and 409 with nothing written by the second; the rules refuse
//      with their paths (a number for a value among them); a taken symbol and a stale delete are
//      conflicts; a foreign Origin, an unknown entry and the session of another installation are
//      refused.
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_PATH, configEntryDeletedSchema, configEntryListSchema, configEntryPath, configEntrySchema } from "@openlife/contracts/http/config";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { afterEach, describe, expect, it } from "vitest";
import { installation, post, query, readyOwner, send, stopServers, type Installation } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(stopServers);

type FixtureEntry = { symbol: string; displayName: string; value: string; description: string };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { configEntries: FixtureEntry[] };
const NORMA = fixture.configEntries[0]!;
const normaDraft = () => ({ symbol: NORMA.symbol, displayName: NORMA.displayName, value: NORMA.value, description: NORMA.description });
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const issues = (reply: { json: () => unknown }): unknown => apiErrorSchema.parse(reply.json()).details?.["issues"];
const audits = (setup: Installation) => query<{ action: string; details: string }>(setup.instance, "SELECT action, details FROM audit_log WHERE action LIKE 'config.%' ORDER BY rowid").map((entry) => [entry.action, JSON.parse(entry.details) as unknown]);
const technicalLog = (setup: Installation): string => readFileSync(path.join(setup.instance.dir, "data", "logs", "app", "app.jsonl"), "utf8");

async function owner(): Promise<{ setup: Installation; cookie: string }> {
  const setup = await installation();
  return { setup, cookie: (await readyOwner(setup)).sessionCookie };
}

describe("D25.2-AC1 the entry of F01 through the real API", () => {
  it("is created, listed as the text 20, saved and deleted; the audit of the database has both values, the technical log and the answers have none", async () => {
    const { setup, cookie } = await owner();
    const { server } = setup;
    // Values no other text of the server could hold, to find them anywhere they leak.
    const marked = "znacznik-wartosci-d25-2-a7f3";
    const refusedMark = "znacznik-odmowy-d25-2-c91e";

    const created = await post(server, CONFIG_PATH, normaDraft(), { cookie });
    expect(created.status).toBe(201);
    expect(configEntrySchema.parse(created.json())).toMatchObject({ symbol: "norma_czytania", displayName: "Norma czytania", value: "20", description: NORMA.description, revision: 1, bindings: 0 });
    expect(created.headers.get("cache-control")).toBe("no-store");

    const listed = configEntryListSchema.parse((await send(server, "GET", CONFIG_PATH, undefined, { cookie })).json());
    expect(listed.entries.map(({ symbol, value, bindings }) => ({ symbol, value, bindings }))).toEqual([{ symbol: "norma_czytania", value: "20", bindings: 0 }]);
    expect(typeof listed.entries[0]!.value).toBe("string");
    expect(configEntrySchema.parse((await send(server, "GET", configEntryPath(NORMA.symbol), undefined, { cookie })).json()).value).toBe("20");

    const saved = await send(server, "PUT", configEntryPath(NORMA.symbol), { expectedRevision: 1, displayName: "Norma czytania", value: marked, description: "" }, { cookie });
    expect(saved.status).toBe(200);
    expect(configEntrySchema.parse(saved.json())).toMatchObject({ value: marked, description: "", revision: 2 });

    // A refusal names the field and the code, never what was sent.
    const refused = await send(server, "PUT", configEntryPath(NORMA.symbol), { expectedRevision: 2, displayName: "Norma", value: marked, description: `${refusedMark}\u0007` }, { cookie });
    expect([refused.status, code(refused), issues(refused)]).toEqual([422, "VALIDATION_FAILED", [{ path: "description", code: "DESCRIPTION_INVALID" }]]);
    const stale = await send(server, "PUT", configEntryPath(NORMA.symbol), { expectedRevision: 1, displayName: "Norma", value: refusedMark }, { cookie });
    expect([stale.status, code(stale)]).toEqual([409, "CONFIG_CHANGED"]);
    for (const reply of [refused, stale]) expect(reply.text).not.toMatch(/znacznik/);

    const deleted = await send(server, "DELETE", configEntryPath(NORMA.symbol), { expectedRevision: 2 }, { cookie });
    expect(deleted.status).toBe(200);
    expect(configEntryDeletedSchema.parse(deleted.json())).toEqual({ bindings: 0 });
    expect(configEntryListSchema.parse((await send(server, "GET", CONFIG_PATH, undefined, { cookie })).json()).entries).toEqual([]);
    expect((await send(server, "GET", configEntryPath(NORMA.symbol), undefined, { cookie })).status).toBe(404);

    expect(audits(setup)).toEqual([
      ["config.created", { symbol: "norma_czytania", value: "20" }],
      ["config.updated", { symbol: "norma_czytania", oldValue: "20", newValue: marked }],
      ["config.deleted", { symbol: "norma_czytania", oldValue: marked, bindings: 0 }],
    ]);
    // The requests were logged, each with its route and outcome, and no value with them.
    const log = technicalLog(setup);
    expect(log).toContain(CONFIG_PATH);
    for (const text of [log, server.output()]) {
      expect(text).not.toContain(marked);
      expect(text).not.toContain(refusedMark);
      expect(text).not.toContain("Norma czytania");
    }
  });
});

describe("D25.2-AC2 what the API refuses", () => {
  it("two saves of revision 1 are 200 and 409; the rules refuse with their paths; a taken symbol and a stale delete are conflicts; nothing refused is stored", async () => {
    const { setup, cookie } = await owner();
    const { server } = setup;
    expect((await post(server, CONFIG_PATH, normaDraft(), { cookie })).status).toBe(201);
    const first = await send(server, "PUT", configEntryPath(NORMA.symbol), { expectedRevision: 1, displayName: "Norma", value: "25" }, { cookie });
    const second = await send(server, "PUT", configEntryPath(NORMA.symbol), { expectedRevision: 1, displayName: "Norma", value: "30" }, { cookie });
    expect([first.status, second.status, code(second)]).toEqual([200, 409, "CONFIG_CHANGED"]);
    const stored = () => query(setup.instance, "SELECT symbol, display_name, value, description, revision FROM config_entry ORDER BY symbol");
    const before = stored();
    expect(before).toEqual([{ symbol: "norma_czytania", display_name: "Norma", value: "25", description: "", revision: 2 }]);

    const taken = await post(server, CONFIG_PATH, normaDraft(), { cookie });
    expect([taken.status, code(taken)]).toEqual([409, "CONFIG_SYMBOL_TAKEN"]);
    const number = await post(server, CONFIG_PATH, { ...normaDraft(), symbol: "norma_liczbowa", value: 20 }, { cookie });
    expect([number.status, code(number), issues(number)]).toEqual([422, "VALIDATION_FAILED", [{ path: "value", code: "VALUE_NOT_TEXT" }]]);
    const bad = await post(server, CONFIG_PATH, { symbol: "Zły symbol", displayName: " ", value: "ł".repeat(10_001), description: "x".repeat(501) }, { cookie });
    expect([bad.status, issues(bad)]).toEqual([422, [{ path: "symbol", code: "SYMBOL_PATTERN" }, { path: "displayName", code: "NAME_EMPTY" }, { path: "value", code: "VALUE_TOO_LONG" }, { path: "description", code: "DESCRIPTION_TOO_LONG" }]]);
    const extra = await post(server, CONFIG_PATH, { ...normaDraft(), symbol: "inny", ownerId: "someone-else" }, { cookie });
    expect([extra.status, code(extra)]).toEqual([422, "VALIDATION_FAILED"]);
    const staleDelete = await send(server, "DELETE", configEntryPath(NORMA.symbol), { expectedRevision: 1 }, { cookie });
    expect([staleDelete.status, code(staleDelete)]).toEqual([409, "CONFIG_CHANGED"]);
    expect((await send(server, "PUT", configEntryPath("nieznany"), { expectedRevision: 1, displayName: "X", value: "" }, { cookie })).status).toBe(404);
    expect(stored()).toEqual(before);
  });

  it("a foreign Origin and the session of another installation change and read nothing", async () => {
    const { setup, cookie } = await owner();
    const { server } = setup;
    expect((await post(server, CONFIG_PATH, normaDraft(), { cookie })).status).toBe(201);
    const foreignOrigin = await post(server, CONFIG_PATH, { ...normaDraft(), symbol: "obcy" }, { cookie, origin: "https://evil.example" });
    expect([foreignOrigin.status, code(foreignOrigin)]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    const foreignDelete = await send(server, "DELETE", configEntryPath(NORMA.symbol), { expectedRevision: 1 }, { cookie, origin: "https://evil.example" });
    expect(foreignDelete.status).toBe(403);

    const other = await installation();
    const foreign = (await readyOwner(other)).sessionCookie;
    for (const [method, route, body] of [["GET", CONFIG_PATH, undefined], ["GET", configEntryPath(NORMA.symbol), undefined], ["PUT", configEntryPath(NORMA.symbol), { expectedRevision: 1, displayName: "X", value: "" }]] as const) {
      const reply = await send(server, method, route, body, { cookie: foreign });
      expect([method, route, reply.status, code(reply)]).toEqual([method, route, 401, "AUTH_REQUIRED"]);
    }
    expect(query(setup.instance, "SELECT symbol, value, revision FROM config_entry")).toEqual([{ symbol: "norma_czytania", value: "20", revision: 1 }]);
  });
});
