// D41.3 — the application options over HTTP, on the in-process app of the harness (Architektura §14.1,
// §14.3, §6; DEV §9.38): the routes, the codes and `requestId` of the refusals, and the effect of a change
// on the limits the modules read at their next use.
// AC1: no session is 401 and a foreign Origin 403 on each route; the list holds every option with its
//      source and what the owner may change, and no name of an environment variable; two options are
//      changed at once or none; an unknown key, a locked option and an option with a second factor are
//      refused with their codes; a reset gives the default back and does not get round a lock.
// AC2: a lower limit applies to the next write and trims nothing that is stored: the limit of registries
//      refuses the next one and keeps the existing, the limit of text refuses a longer new value and lets
//      a long stored one be read and kept while another field is edited, the limit of a record refuses a
//      larger record; a reset gives the old limit back.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, registryRecordPath, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { settingListSchema, settingPath, SETTINGS_PATH } from "@openlife/contracts/http/settings";
import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, type HarnessOptions } from "../../support/app-harness.ts";
import { ownerSession } from "../../support/harness-owner.ts";

afterEach(closeHarnesses);

const NOTES = { symbol: "notatki", displayName: "Notatki", columns: [{ symbol: "tytul", displayName: "Tytuł", type: "text", typeOptions: {}, defaultValue: null, required: false }, { symbol: "opis", displayName: "Opis", type: "text", typeOptions: {}, defaultValue: null, required: false }] };

/** An owner past the gate with the empty start, and the calls the tests make. */
async function owner(options: HarnessOptions = {}) {
  const { h, cookie, chooseEmpty } = await ownerSession(options);
  await chooseEmpty();
  const call = (method: string, route: string, body?: unknown, headers?: Record<string, string>) => h.request(method, route, body, { cookie, ...(headers === undefined ? {} : { headers }) });
  const list = async () => settingListSchema.parse((await call("GET", SETTINGS_PATH)).json()).settings;
  const optionOf = async (key: string) => (await list()).find((setting) => setting.key === key);
  return { h, cookie, call, list, optionOf };
}
const issuesOf = (reply: { json: () => unknown }) => apiErrorSchema.parse(reply.json());
let keys = 0;
const record = (values: Record<string, unknown>) => ({ schemaRevision: 1, values });
const nextKey = () => ({ [IDEMPOTENCY_KEY_HEADER]: `d41-3-key-${(keys += 1)}` });

describe("D41.3-AC1 the routes of the options", () => {
  it("no session is 401 and a foreign Origin 403 on the list, the change and the reset", async () => {
    const { h, cookie } = await owner();
    for (const [method, route, body] of [["GET", SETTINGS_PATH, undefined], ["PATCH", SETTINGS_PATH, { values: { "limits.registries": 5 } }], ["DELETE", settingPath("limits.registries"), {}]] as const) {
      const bare = await h.request(method, route, body, {});
      expect([method, bare.status, issuesOf(bare).code]).toEqual([method, 401, "AUTH_REQUIRED"]);
    }
    const foreign = await h.request("PATCH", SETTINGS_PATH, { values: { "limits.registries": 5 } }, { cookie, origin: "https://elsewhere.example" });
    expect([foreign.status, issuesOf(foreign).code]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    const foreignReset = await h.request("DELETE", settingPath("limits.registries"), {}, { cookie, origin: "https://elsewhere.example" });
    expect(foreignReset.status).toBe(403);
  });

  it("lists every option of the catalog with its source and what the owner may do, and names no environment variable", async () => {
    const { call, list } = await owner({ environment: { "limits.importMaxMiB": 200 } });
    const reply = await call("GET", SETTINGS_PATH);
    expect(reply.status).toBe(200);
    expect(reply.text).not.toMatch(/IMPORT_MAX_MIB|RECORD_MAX_KIB|BACKUP_DISK_RESERVE_MIB|JSON_BODY_KIB/);
    const settings = await list();
    expect(settings.map((setting) => setting.key)).toEqual(SETTINGS_CATALOG.map((definition) => definition.key));
    expect(settings.find((setting) => setting.key === "limits.registries")).toMatchObject({ type: "integer", value: 200, defaultValue: 200, source: "default", editable: true, restartRequired: false, stepUp: false, unit: "count", min: 1, max: 1000 });
    expect(settings.find((setting) => setting.key === "logs.level")).toMatchObject({ type: "enum", value: "info", values: ["error", "warn", "info", "debug"] });
    expect(settings.find((setting) => setting.key === "limits.importMaxMiB")).toMatchObject({ value: 200, source: "env", editable: false, restartRequired: true });
    expect(settings.find((setting) => setting.key === "limits.jsonBodyKiB")).toMatchObject({ editable: false, restartRequired: true });
    expect(settings.find((setting) => setting.key === "backup.nightlyKeep")).toMatchObject({ stepUp: true });
  });

  it("changes two options at once and keeps them, or changes none when one is refused, with the code and the reference of the refusal", async () => {
    const { call, optionOf } = await owner();
    const changed = await call("PATCH", SETTINGS_PATH, { values: { "limits.registries": 10, "tables.defaultPageSize": 50 } });
    expect(changed.status).toBe(200);
    expect(settingListSchema.parse(changed.json()).settings.filter((setting) => setting.source === "db").map((setting) => [setting.key, setting.value])).toEqual([["tables.defaultPageSize", 50], ["limits.registries", 10]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).sort((a, b) => SETTINGS_CATALOG.findIndex((d) => d.key === a[0]) - SETTINGS_CATALOG.findIndex((d) => d.key === b[0])));

    const refused = await call("PATCH", SETTINGS_PATH, { values: { "limits.registries": 20, "no.such.option": 1 } });
    expect(refused.status).toBe(422);
    const error = issuesOf(refused);
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", details: { issues: [{ path: "values.no.such.option", code: "SETTING_UNKNOWN" }] } });
    expect(error.requestId).toMatch(/\S/);
    expect(await optionOf("limits.registries")).toMatchObject({ value: 10, source: "db" });
    for (const body of [{}, { values: [] }, { values: { "limits.registries": 5 }, extra: 1 }, "not json"]) expect((await call("PATCH", SETTINGS_PATH, body)).status, JSON.stringify(body)).toBe(422);
  });

  it("refuses an option locked by the environment, a read-only one and one that asks for a second factor, and a reset does not get round the lock", async () => {
    const { h, call, optionOf } = await owner({ environment: { "limits.importMaxMiB": 200 } });
    // The second factor of this session was proven ten minutes ago: no longer fresh (D43.4).
    h.sql("UPDATE session_ext SET totp_verified_at_ms = totp_verified_at_ms - 600000");
    const locked = await call("PATCH", SETTINGS_PATH, { values: { "limits.importMaxMiB": 300 } });
    expect([locked.status, issuesOf(locked).details]).toEqual([422, { issues: [{ path: "values.limits.importMaxMiB", code: "SETTING_LOCKED_BY_ENV" }] }]);
    const readOnly = await call("PATCH", SETTINGS_PATH, { values: { "limits.jsonBodyKiB": 512 } });
    expect(issuesOf(readOnly).details).toEqual({ issues: [{ path: "values.limits.jsonBodyKiB", code: "SETTING_READ_ONLY" }] });
    const stepUp = await call("PATCH", SETTINGS_PATH, { values: { "backup.nightlyKeep": 20 } });
    expect([stepUp.status, issuesOf(stepUp).code]).toEqual([403, "STEP_UP_REQUIRED"]);
    expect(await optionOf("limits.importMaxMiB")).toMatchObject({ value: 200, source: "env" });

    const reset = await call("DELETE", settingPath("limits.importMaxMiB"), {});
    expect(reset.status).toBe(200);
    expect(reset.json()).toMatchObject({ key: "limits.importMaxMiB", value: 200, source: "env", editable: false });
    expect((await call("DELETE", settingPath("no.such.option"), {})).status).toBe(404);
    expect((await call("DELETE", settingPath("audit.retentionDays"), {})).status).toBe(403);
  });

  it("an option that asks for a second factor changes and resets with a fresh one, and with an old one nothing is written", async () => {
    const { h, call, optionOf } = await owner();
    expect(await optionOf("backup.nightlyKeep")).toMatchObject({ stepUp: true, source: "default" });
    const changed = await call("PATCH", SETTINGS_PATH, { values: { "backup.nightlyKeep": 20 } });
    expect(changed.status).toBe(200);
    expect(await optionOf("backup.nightlyKeep")).toMatchObject({ value: 20, source: "db" });
    const audit = h.rows<{ action: string; details: string }>("SELECT action, details FROM audit_log WHERE action = 'setting.changed' AND entity_id = 'backup.nightlyKeep'");
    expect(audit).toHaveLength(1);

    // The factor is proven ten minutes ago: the change and the reset are refused and the value stays.
    h.sql("UPDATE session_ext SET totp_verified_at_ms = totp_verified_at_ms - 600000");
    for (const [method, route, body] of [["PATCH", SETTINGS_PATH, { values: { "backup.nightlyKeep": 30 } }], ["DELETE", settingPath("backup.nightlyKeep"), {}]] as const) {
      const refused = await call(method, route, body);
      expect([method, refused.status, issuesOf(refused).code]).toEqual([method, 403, "STEP_UP_REQUIRED"]);
    }
    expect(await optionOf("backup.nightlyKeep")).toMatchObject({ value: 20, source: "db" });

    // Fresh again: the reset gives the default back.
    h.sql("UPDATE session_ext SET totp_verified_at_ms = totp_verified_at_ms + 600000");
    const reset = await call("DELETE", settingPath("backup.nightlyKeep"), {});
    expect(reset.status).toBe(200);
    expect(await optionOf("backup.nightlyKeep")).toMatchObject({ source: "default" });
  });

  it("a reset gives the default back", async () => {
    const { call, optionOf } = await owner();
    await call("PATCH", SETTINGS_PATH, { values: { "logs.level": "debug" } });
    expect(await optionOf("logs.level")).toMatchObject({ value: "debug", source: "db" });
    const reset = await call("DELETE", settingPath("logs.level"), {});
    expect(reset.json()).toMatchObject({ key: "logs.level", value: "info", source: "default" });
    expect(await optionOf("logs.level")).toMatchObject({ value: "info", source: "default" });
  });
});

describe("D41.3-AC2 a change applies to the next write and trims nothing", () => {
  it("the limit of registries refuses the next registry and keeps the existing ones, and a reset lets one be made again", async () => {
    const { call } = await owner();
    expect((await call("POST", REGISTRIES_PATH, NOTES)).status).toBe(201);
    expect((await call("PATCH", SETTINGS_PATH, { values: { "limits.registries": 1 } })).status).toBe(200);
    const second = await call("POST", REGISTRIES_PATH, { ...NOTES, symbol: "inne", displayName: "Inne" });
    expect([second.status, issuesOf(second).code]).toEqual([409, "REGISTRY_LIMIT_EXCEEDED"]);
    expect((await call("GET", REGISTRIES_PATH)).text).toContain("notatki");
    await call("DELETE", settingPath("limits.registries"), {});
    expect((await call("POST", REGISTRIES_PATH, { ...NOTES, symbol: "inne", displayName: "Inne" })).status).toBe(201);
  });

  it("the limit of text refuses a longer new value, and a longer value already stored is read and kept while another field is edited", async () => {
    const { call } = await owner();
    await call("POST", REGISTRIES_PATH, NOTES);
    const longText = "x".repeat(30);
    const added = await call("POST", registryRecordsPath("notatki"), record({ tytul: longText, opis: "krótki" }), nextKey());
    expect(added.status).toBe(201);
    const id = (added.json() as { id: string }).id;

    expect((await call("PATCH", SETTINGS_PATH, { values: { "limits.textLength": 10 } })).status).toBe(200);
    const tooLong = await call("POST", registryRecordsPath("notatki"), record({ tytul: "y".repeat(11) }), nextKey());
    expect([tooLong.status, issuesOf(tooLong).code]).toEqual([422, "VALIDATION_FAILED"]);
    expect((await call("POST", registryRecordsPath("notatki"), record({ tytul: "y".repeat(10) }), nextKey())).status).toBe(201);

    expect(((await call("GET", registryRecordPath("notatki", id))).json() as { values: { tytul: string } }).values.tytul).toBe(longText);
    const edited = await call("PATCH", registryRecordPath("notatki", id), { schemaRevision: 1, expectedRevision: 1, values: { opis: "nowy" } });
    expect(edited.status).toBe(200);
    expect((edited.json() as { values: { tytul: string; opis: string } }).values).toMatchObject({ tytul: longText, opis: "nowy" });
    const longer = await call("PATCH", registryRecordPath("notatki", id), { schemaRevision: 1, expectedRevision: 2, values: { tytul: "z".repeat(31) } });
    expect(longer.status).toBe(422);
  });

  it("the limit of a record refuses a larger record and the old limit comes back with the reset", async () => {
    const { call } = await owner();
    await call("POST", REGISTRIES_PATH, NOTES);
    const wide = "w".repeat(1500);
    expect((await call("POST", registryRecordsPath("notatki"), record({ tytul: wide }), nextKey())).status).toBe(201);
    expect((await call("PATCH", SETTINGS_PATH, { values: { "limits.recordMaxKiB": 1 } })).status).toBe(200);
    const large = await call("POST", registryRecordsPath("notatki"), record({ tytul: wide }), nextKey());
    expect([large.status, issuesOf(large).details]).toEqual([422, { issues: [{ path: "values", code: "RECORD_TOO_LARGE" }] }]);
    await call("DELETE", settingPath("limits.recordMaxKiB"), {});
    expect((await call("POST", registryRecordsPath("notatki"), record({ tytul: wide }), nextKey())).status).toBe(201);
  });
});
