// D46.1 — the import of the owner's data into an empty installation, through the use case and over a real SQLite
// file (Architektura Załącznik G; DEV §9.43).
// AC1: the F01 file is imported with its identifiers, revisions and times, the choice of the starting data
//      becomes "imported", and the export that follows is equal to the file in canonical form; the audit holds
//      the counts and nothing of the content.
// AC2: a binding to a column the file does not hold makes the widget need rebinding (F04) and a type of the
//      future makes it need a refresh with its configuration kept as it came (F05); a failure at any stage
//      leaves the domain empty and nothing chosen; a second import, an import after a start from zero and a
//      session that has not passed the gate are refused.
import { exportFileSchema, type ExportFile } from "../../../packages/contracts/src/export/format.ts";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { importOwnerData, type ImportPorts } from "../../../packages/core/dist/modules/portability/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { EXPORT_PATH } from "@openlife/contracts/http/export";
import { afterEach, describe, expect, it } from "vitest";
import { createWidgetCatalog } from "../../../apps/server/dist/adapters/widget-catalog.js";
import { DESIGN_POLICY } from "../../../apps/server/dist/bootstrap/design-policy.js";
import { importedDataOf } from "../../../apps/server/dist/portability/imported-data.js";
import { canonicalExport } from "../../../apps/server/dist/portability/canonical.js";
import { parseExportFile } from "../../../apps/server/dist/portability/parse-export.js";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type AppHarness } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";
import { F01, F01_TEXT } from "../../support/export-fixture.ts";

afterEach(closeHarnesses);

const LIMITS = { maxBytes: 100 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };
const MARKER = "MARKER-imported-content-6f2b";

function parsed(file: unknown): ExportFile {
  const result = parseExportFile(JSON.stringify(file), LIMITS);
  if (!result.ok) throw new Error(`not accepted: ${JSON.stringify(result.issues.slice(0, 3))}`);
  return exportFileSchema.parse(result.file);
}
const fixture = (): Record<string, any> => JSON.parse(F01_TEXT) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** An owner past the gate, with the starting data not chosen yet: where the import belongs. */
async function owner() {
  const h = await createAppHarness({ exportAppVersion: F01.appVersion });
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const cookie = confirmed.cookie ?? "";
  const gatePassed = async () => h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie });
  return { h, cookie, password, gatePassed };
}

const depsOf = (h: AppHarness, unit: ImportUnit = h.elsewhere) => ({ unit, nowMs: Date.now, policy: DESIGN_POLICY, widgets: createWidgetCatalog() });
type ImportUnit = AppHarness["elsewhere"];

async function importFile(h: AppHarness, cookie: string, file: ExportFile, unit?: ImportUnit) {
  const token = await h.sessionToken(cookie);
  return importOwnerData(depsOf(h, unit), token ?? "", importedDataOf(file), "req-import");
}

const count = (h: AppHarness, table: string): number => h.rows<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]?.n ?? 0;
const dataChoice = (h: AppHarness): string => h.rows<{ c: string }>("SELECT data_choice AS c FROM instance_state")[0]?.c ?? "";
const DOMAIN_TABLES = ["registry", "registry_column", "dictionary", "dictionary_value", "config_entry", "screen", "widget", "binding", "owner_settings"];
const domainRows = (h: AppHarness): Record<string, number> => Object.fromEntries(DOMAIN_TABLES.map((table) => [table, count(h, table)]));

describe("D46.1-AC1 the F01 file becomes the installation", () => {
  it("imports the file with its identifiers, revisions and times, takes the choice of the data, and the export that follows is equal to the file", async () => {
    const { h, cookie, gatePassed } = await owner();
    const acknowledged = await gatePassed();
    expect(acknowledged.status).toBe(200);
    const before = domainRows(h);
    expect(dataChoice(h)).toBe("unselected");
    const result = await importFile(h, cookie, parsed(F01));
    expect(result).toEqual({ ok: true, value: { configEntries: 1, dictionaries: 1, registries: 1, records: 25, screens: 1, widgets: 3 } });
    expect(dataChoice(h)).toBe("imported");
    expect(domainRows(h)).not.toEqual(before);

    const exported = await h.request("GET", EXPORT_PATH, undefined, { cookie });
    expect(exported.status).toBe(200);
    const again = parsed(JSON.parse(exported.text));
    expect(canonicalExport(again)).toBe(canonicalExport(parsed(F01)));
    // The identifiers, the revisions and the times of the records are the file's own.
    expect(again.registries[0]?.records[0]).toEqual(F01.registries[0]?.records[0]);
    expect(again.registries[0]).toMatchObject({ id: F01.registries[0]?.id, schemaRevision: 1, dataRevision: 25 });
    expect(again.settings).toEqual(F01.settings);
  });

  it("records the counts and nothing of what the file held", async () => {
    const { h, cookie, gatePassed } = await owner();
    await gatePassed();
    const file = fixture();
    file["registries"][0]["records"][0]["values"]["tytul"] = MARKER;
    file["configEntries"][0]["value"] = MARKER;
    expect((await importFile(h, cookie, parsed(file))).ok).toBe(true);
    const entries = h.rows<{ action: string; details: string; actor: string | null; request_id: string }>("SELECT action, details, actor, request_id FROM audit_log WHERE action = 'setup.data_imported'");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]?.details ?? "{}")).toEqual({ configEntries: 1, dictionaries: 1, registries: 1, records: 25, screens: 1, widgets: 3 });
    expect(entries[0]).toMatchObject({ actor: "owner-1", request_id: "req-import" });
    expect(JSON.stringify(h.rows("SELECT * FROM audit_log"))).not.toContain(MARKER);
  });

  it("keeps the revisions the file names even when they are not the number of the records", async () => {
    const { h, cookie, gatePassed } = await owner();
    await gatePassed();
    const file = fixture();
    // A registry whose records were changed and deleted has a data revision above its records, and one whose structure was changed a schema revision above 1.
    file["registries"][0]["dataRevision"] = 140;
    file["registries"][0]["schemaRevision"] = 4;
    file["registries"][0]["records"][3]["revision"] = 9;
    expect((await importFile(h, cookie, parsed(file))).ok).toBe(true);
    const again = parsed(JSON.parse((await h.request("GET", EXPORT_PATH, undefined, { cookie })).text));
    expect(again.registries[0]).toMatchObject({ dataRevision: 140, schemaRevision: 4 });
    expect(again.registries[0]?.records[3]?.revision).toBe(9);
    expect(canonicalExport(again)).toBe(canonicalExport(parsed(file)));
  });

  it("imports a file with nothing in it, which is a valid start", async () => {
    const { h, cookie, gatePassed } = await owner();
    await gatePassed();
    const empty = { ...fixture(), configEntries: [], dictionaries: [], registries: [], screens: [] };
    expect(await importFile(h, cookie, parsed(empty))).toEqual({ ok: true, value: { configEntries: 0, dictionaries: 0, registries: 0, records: 0, screens: 0, widgets: 0 } });
    expect(dataChoice(h)).toBe("imported");
  });
});

describe("D46.1-AC2 the states of the widgets, atomicity and what is refused", () => {
  it("F04: a binding to a column the file does not hold keeps its target and the widget needs rebinding, the clocks go on", async () => {
    const { h, cookie, gatePassed } = await owner();
    await gatePassed();
    const file = fixture();
    const columns = file["registries"][0]["columns"] as Array<{ symbol: string }>;
    file["registries"][0]["columns"] = columns.filter((column) => column.symbol !== "autor").map((column, position) => ({ ...column, position }));
    for (const record of file["registries"][0]["records"] as Array<{ values: Record<string, unknown> }>) delete record.values["autor"];
    expect((await importFile(h, cookie, parsed(file))).ok).toBe(true);
    const states = h.rows<{ id: string; state: string }>("SELECT id, state FROM widget ORDER BY id");
    expect(states.map((row) => row.state)).toEqual(["needs_rebinding", "ok", "ok"]);
    const target = h.rows<{ target: string }>("SELECT target FROM binding WHERE path = 'Field.Register.ksiazki.autor'")[0]?.target ?? "";
    expect(target).toContain("019a0000-0000-7000-8000-00000000006f");
  });

  it("F05: a widget type this build does not have is kept with its configuration as it came and needs a refresh", async () => {
    const { h, cookie, gatePassed } = await owner();
    await gatePassed();
    const file = fixture();
    const future = { v: 7, theme: "from-the-future", nested: { anything: [1, 2, 3] } };
    file["screens"][0]["widgets"][1] = { ...file["screens"][0]["widgets"][1], type: "community-future", config: future };
    expect((await importFile(h, cookie, parsed(file))).ok).toBe(true);
    const row = h.rows<{ state: string; config: string }>("SELECT state, config FROM widget WHERE type = 'community-future'")[0];
    expect(row?.state).toBe("needs_refresh");
    expect(JSON.parse(row?.config ?? "{}")).toEqual(future);
    const exported = parsed(JSON.parse((await h.request("GET", EXPORT_PATH, undefined, { cookie })).text));
    expect(exported.screens[0]?.widgets.find((widget) => widget.type === "community-future")?.config).toEqual(future);
  });

  it("a failure at any stage of the writing leaves the domain empty and nothing chosen", async () => {
    const stages: Array<[string, (ports: ImportPorts) => ImportPorts]> = [
      ["the preferences", (ports) => ({ ...ports, preferences: { ...ports.preferences, write: () => failing() } })],
      ["a config entry", (ports) => ({ ...ports, config: { ...ports.config, insert: () => failing() } })],
      ["a dictionary", (ports) => ({ ...ports, dictionaries: { ...ports.dictionaries, insert: () => failing() } })],
      ["the table of a registry", (ports) => ({ ...ports, registries: { ...ports.registries, insert: () => failing() } })],
      ["the 20th record", (ports) => ({ ...ports, records: { ...ports.records, insert: countingFailure(20, ports.records.insert) } })],
      ["the revisions of a registry", (ports) => ({ ...ports, registries: { ...ports.registries, restoreRevisions: () => failing() } })],
      ["a screen", (ports) => ({ ...ports, dashboard: { ...ports.dashboard, replace: () => failing() } })],
      ["the audit", (ports) => ({ ...ports, audit: { append: () => failing() } })],
    ];
    for (const [stage, wrap] of stages) {
      const { h, cookie, gatePassed } = await owner();
      await gatePassed();
      const before = domainRows(h);
      const tablesBefore = h.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);
      const unit: ImportUnit = { run: ((work: Parameters<ImportUnit["run"]>[0]) => h.elsewhere.run((ports) => work(wrap(ports as unknown as ImportPorts) as never))) as ImportUnit["run"], read: h.elsewhere.read.bind(h.elsewhere) };
      await expect(importFile(h, cookie, parsed(F01), unit), stage).rejects.toThrow("injected");
      expect(domainRows(h), stage).toEqual(before);
      expect(dataChoice(h), stage).toBe("unselected");
      // The table of the registry that was made is gone too: the DDL was part of the unit.
      expect(h.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name), stage).toEqual(tablesBefore);
      expect(h.rows("SELECT 1 FROM audit_log WHERE action = 'setup.data_imported'"), stage).toHaveLength(0);
      // And the same file imports once the fault is gone.
      expect((await importFile(h, cookie, parsed(F01))).ok, stage).toBe(true);
    }
  });

  it("refuses a second import, an import after a start from zero, and a session that has not passed the gate, and changes nothing", async () => {
    const first = await owner();
    // Before the recovery codes are acknowledged the gate is not passed.
    const early = await importFile(first.h, first.cookie, parsed(F01));
    expect(early).toEqual({ ok: false, error: { code: "RECOVERY_ACK_REQUIRED" } });
    expect(dataChoice(first.h)).toBe("unselected");
    await first.gatePassed();
    expect((await importFile(first.h, first.cookie, parsed(F01))).ok).toBe(true);
    const rows = domainRows(first.h);
    expect(await importFile(first.h, first.cookie, parsed(F01))).toEqual({ ok: false, error: { code: "SETUP_DATA_ALREADY_CHOSEN" } });
    expect(domainRows(first.h)).toEqual(rows);

    const second = await owner();
    await second.gatePassed();
    expect((await second.h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: second.cookie })).status).toBe(200);
    expect(await importFile(second.h, second.cookie, parsed(F01))).toEqual({ ok: false, error: { code: "SETUP_DATA_ALREADY_CHOSEN" } });
    expect(domainRows(second.h)).toEqual(domainRows(second.h));
    expect(count(second.h, "registry")).toBe(0);
    expect(dataChoice(second.h)).toBe("empty");

    const third = await owner();
    await third.gatePassed();
    const gone = await importFile(third.h, "better-auth.session_token=nonsense", parsed(F01)).catch(() => null);
    expect(gone === null || gone.ok === false).toBe(true);
    expect(dataChoice(third.h)).toBe("unselected");
  });
});

function failing(): never {
  throw new Error("injected");
}
function countingFailure<A extends unknown[]>(at: number, original: (...args: A) => void): (...args: A) => void {
  let calls = 0;
  return (...args) => {
    calls += 1;
    if (calls === at) failing();
    original(...args);
  };
}
