// D45.2 — the export over HTTP, on the in-process app of the harness over a real SQLite file (Architektura
// Załącznik G; DEV §9.42).
// AC1: no session is 401 and a session that has not passed the gate is refused; the answer is a file named by
//      the day, not cached and not rendered; the state of F01 loaded with its identifiers is exported to a file
//      that is equal to the fixture in canonical form, and the parser accepts it; nothing of the
//      authentication, the audit or the owner's identifier is in it; a removed column is not in it and the
//      columns that stay are numbered without a gap.
// AC2: a large registry is written a page at a time; a write during the export is not blocked and is not in the
//      file, which is one consistent view; a cancelled export closes its reader; a failure after the first
//      byte ends the transfer with an error and a failure before it is an error answer.
import path from "node:path";
import { exportFileName } from "../../../packages/contracts/src/export/format.ts";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { EXPORT_PATH } from "@openlife/contracts/http/export";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalExport } from "../../../apps/server/dist/portability/canonical.js";
import { parseExportFile, type ParseExportResult } from "../../../apps/server/dist/portability/parse-export.js";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type AppHarness, type HarnessOptions } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";
import { F01, F01_TEXT, loadFixture } from "../../support/export-fixture.ts";

afterEach(closeHarnesses);

const LIMITS = { maxBytes: 100 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };
const parse = (text: string): ParseExportResult => parseExportFile(text, LIMITS);
const parsedOk = (text: string) => {
  const result = parse(text);
  if (!result.ok) throw new Error(`the export is not accepted: ${JSON.stringify(result.issues.slice(0, 3))}`);
  return result.file;
};

async function owner(options: HarnessOptions = {}) {
  const h = await createAppHarness(options);
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  const exported = (cookie: string | null = a) => h.request("GET", EXPORT_PATH, undefined, { cookie });
  const passwordOnly = async (): Promise<string> => (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  return { h, a, issued, exported, passwordOnly };
}

const addRecords = (h: AppHarness, symbol: string, count: number, from = 0): void => {
  const result = h.elsewhere.run((ports) => {
    const registry = ports.registries.find("owner-1", symbol);
    if (registry === null) throw new Error("no such registry");
    for (let n = from; n < from + count; n += 1) {
      const id = `019b0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
      ports.records.insert(registry, { id, registryId: registry.id, ownerId: "owner-1", revision: 1, createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z", values: { tytul: `Tytuł ${n}` } });
    }
    return { value: null, invalidations: [] };
  });
  if (!result.ok) throw new Error("records were not added");
};

describe("D45.2-AC1 the gate, the file and what is in it", () => {
  it("answers 401 without a session and the code of the gate before the session has passed it", async () => {
    const { exported, passwordOnly } = await owner();
    const anonymous = await exported(null);
    expect([anonymous.status, apiErrorSchema.parse(anonymous.json()).code]).toEqual([401, "AUTH_REQUIRED"]);
    const early = await exported(await passwordOnly());
    expect([early.status, apiErrorSchema.parse(early.json()).code]).toEqual([403, "MFA_REQUIRED"]);
  });

  it("is a file named by the day, not cached and not rendered, that sets no cookie", async () => {
    const { h, a } = await owner();
    const response = await h.open(EXPORT_PATH, { cookie: a });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="openlifedashboard-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get("content-disposition")).toContain(exportFileName(new Date()));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    await response.body?.cancel();
  });

  it("exports an installation with nothing in it as a file the parser accepts, with the defaults for the settings", async () => {
    const { exported } = await owner();
    const reply = await exported();
    const file = parsedOk(reply.text);
    expect(file).toMatchObject({ format: "openlifedashboard-export", formatVersion: 1, appVersion: "0.0.0", settings: { timezone: "UTC", locale: "pl", dateFormat: "DD.MM.YYYY" }, configEntries: [], dictionaries: [], registries: [], screens: [] });
    expect(Math.abs(Date.parse(file.exportedAt) - Date.now())).toBeLessThan(60_000);
  });

  it("exports the F01 state to a file equal to the fixture in canonical form, and the parser accepts it", async () => {
    // Two exports are compared on the same version of the application: the one the fixture names.
    const { h, exported } = await owner({ exportAppVersion: F01.appVersion });
    loadFixture(h);
    const reply = await exported();
    expect(reply.status).toBe(200);
    const file = parsedOk(reply.text);
    expect(file.registries[0]?.records).toHaveLength(25);
    expect(file.registries[0]).toMatchObject({ schemaRevision: 1, dataRevision: 25 });
    expect(canonicalExport(file)).toBe(canonicalExport(parsedOk(F01_TEXT)));
    expect(file.exportedAt).not.toBe(F01.exportedAt);
  });

  it("holds nothing of the authentication, the audit, the owner's identifier or a user id", async () => {
    const { h, a, issued, exported } = await owner();
    loadFixture(h);
    // The audit has entries by now (sign-ins, the enrollment); none of them is in the file.
    const reply = await exported();
    for (const word of ["user_id", "userId", "owner-1", HARNESS_EMAIL, HARNESS_PASSWORD, "audit", "session", "totp", "recovery", "trusted", "access_epoch", ...issued.recoveryCodes, a.slice(a.indexOf("=") + 1)]) {
      expect(reply.text, word).not.toContain(word);
    }
    expect(Object.keys(JSON.parse(reply.text) as object)).toEqual(["format", "formatVersion", "appVersion", "exportedAt", "settings", "configEntries", "dictionaries", "registries", "screens"]);
  });

  it("leaves out the values of a removed column and numbers the columns that stay without a gap", async () => {
    const { h, exported } = await owner();
    loadFixture(h);
    const removed = h.elsewhere.run((ports) => {
      const registry = ports.registries.find("owner-1", "ksiazki");
      const column = registry?.columns.find((candidate) => candidate.symbol === "autor");
      if (registry === null || column === undefined) throw new Error("no column");
      ports.registries.removeColumn(registry, column.id, "2026-10-03T10:00:00Z");
      return { value: null, invalidations: [] };
    });
    expect(removed.ok).toBe(true);
    const file = parsedOk((await exported()).text);
    const registry = file.registries[0];
    expect(registry?.columns.map((column) => column.symbol)).not.toContain("autor");
    expect(registry?.columns.map((column) => column.position)).toEqual(registry?.columns.map((_, index) => index));
    expect(registry?.records.every((record) => !("autor" in record.values))).toBe(true);
  });
});

describe("D45.2-AC2 the stream and its consistency", () => {
  it("writes a large registry a page at a time, in the order of the identifiers, and keeps every record", async () => {
    const { h, a } = await owner({ exportRecordsPerPage: 50 });
    loadFixture(h);
    addRecords(h, "ksiazki", 2_300);
    const response = await h.open(EXPORT_PATH, { cookie: a });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const parts: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(new TextDecoder().decode(value));
    }
    // 2 325 records at 50 a page, plus the parts before and after them.
    expect(parts.length).toBeGreaterThan(45);
    const file = parsedOk(parts.join(""));
    const ids = file.registries[0]?.records.map((record) => record.id) ?? [];
    expect(ids).toHaveLength(2_325);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not block a write during the export, and the file is the view of the moment it began", async () => {
    const { h, a, exported } = await owner({ exportRecordsPerPage: 50 });
    loadFixture(h);
    addRecords(h, "ksiazki", 200);
    const response = await h.open(EXPORT_PATH, { cookie: a });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const first = await reader.read();
    expect(first.done).toBe(false);
    // The export is open now: a record is added and another is changed by the owner, and nothing waits.
    const started = Date.now();
    const created = await h.request("POST", "/api/v1/registries/ksiazki/records", { schemaRevision: 1, values: { tytul: "Dopisana w czasie eksportu" } }, { cookie: a, headers: { "Idempotency-Key": "d45-2-during" } });
    expect(created.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(2_000);
    const decoder = new TextDecoder();
    let text = decoder.decode(first.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const during = parsedOk(text);
    expect(during.registries[0]?.records).toHaveLength(225);
    expect(during.registries[0]?.records.some((record) => record.values["tytul"] === "Dopisana w czasie eksportu")).toBe(false);
    // The next export has it.
    const after = parsedOk((await exported()).text);
    expect(after.registries[0]?.records).toHaveLength(226);
  });

  it("closes its reader when the transfer is cancelled, and the next export works", async () => {
    const { h, a, exported } = await owner({ exportRecordsPerPage: 50 });
    loadFixture(h);
    addRecords(h, "ksiazki", 300);
    const response = await h.open(EXPORT_PATH, { cookie: a });
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    expect(h.logLines().some((entry) => entry.includes('"event":"export.cancelled"'))).toBe(true);
    expect(parsedOk((await exported()).text).registries[0]?.records).toHaveLength(325);
  });

  it("ends the transfer with an error when it fails after the first byte, and says so in the log", async () => {
    const { h, a } = await owner({ exportRecordsPerPage: 50 });
    loadFixture(h);
    // The catalog still names the table; the records cannot be read.
    h.sql('DROP TABLE "reg_ksiazki"');
    const response = await h.open(EXPORT_PATH, { cookie: a });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(h.logLines().some((entry) => entry.includes('"event":"export.failed"') && entry.includes('"code":"EXPORT_FAILED"'))).toBe(true);
  });

  it("answers an error, not a file, when the export cannot start", async () => {
    const { exported } = await owner({ exportDatabaseFile: path.join("/nonexistent", "folder", "app.db") });
    const reply = await exported();
    expect([reply.status, apiErrorSchema.parse(reply.json()).code]).toEqual([503, "EXPORT_UNAVAILABLE"]);
    expect(reply.text).not.toContain("nonexistent");
  });
});
