// D46.2 — the import over HTTP, on the in-process app of the harness over a real SQLite file (Architektura
// Załącznik G, §9.7; DEV §9.43).
// AC1: no session is 401, a foreign Origin and a session that has not passed the gate are 403, all of them
//      before the body is read; a file over `limits.importMaxMiB` is 413; a file the parser does not accept is
//      422 with the paths and the codes and nothing of the values; after any refusal nothing is written and
//      the choice of the data is still open, so the same installation takes a good file afterwards.
// AC2: the export of installation A, imported into the empty installation B, is equal to it in canonical form;
//      two imports at once leave one winner and the other is 409; an import after a start from zero, a start
//      from zero after an import and a second import are refused; a failure inside the write is 503 and
//      takes everything back.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { EXPORT_PATH } from "@openlife/contracts/http/export";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { importResponseSchema, SETUP_IMPORT_PATH, SETUP_STATUS_PATH } from "@openlife/contracts/http/setup";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalExport } from "../../../apps/server/dist/portability/canonical.js";
import { parseExportFile } from "../../../apps/server/dist/portability/parse-export.js";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type AppHarness, type HarnessOptions } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";
import { F01, F01_TEXT, loadFixture } from "../../support/export-fixture.ts";

afterEach(closeHarnesses);

const LIMITS = { maxBytes: 100 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };
const MARKER = "MARKER-imported-value-3c91";
const fixture = (): Record<string, any> => JSON.parse(F01_TEXT) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const canonicalOf = (text: string): string => {
  const result = parseExportFile(text, LIMITS);
  if (!result.ok) throw new Error(`not accepted: ${JSON.stringify(result.issues.slice(0, 3))}`);
  return canonicalExport(result.file);
};

/** An installation with the owner signed in, the second factor enrolled and the recovery codes acknowledged or not; the starting data not chosen. */
async function installation(options: HarnessOptions = {}, acknowledged = true) {
  const h = await createAppHarness({ exportAppVersion: F01.appVersion, ...options });
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const cookie = confirmed.cookie ?? "";
  if (acknowledged) await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie });
  const send = (body: string, who: string | null = cookie, origin?: string | null) => h.request("POST", SETUP_IMPORT_PATH, body, origin === undefined ? { cookie: who } : { cookie: who, origin });
  const status = async () => (await h.request("GET", SETUP_STATUS_PATH, undefined, { cookie })).json() as { dataChoice: string; stage: string };
  /** A fresh sign-in with the password only: after the enrollment the first one is spent. */
  const passwordOnly = async (): Promise<string> => (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  return { h, cookie, send, status, passwordOnly };
}

const count = (h: AppHarness, table: string): number => h.rows<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]?.n ?? 0;
const DOMAIN_TABLES = ["registry", "registry_column", "dictionary", "dictionary_value", "config_entry", "screen", "widget", "binding", "owner_settings"];
const domainRows = (h: AppHarness): Record<string, number> => Object.fromEntries(DOMAIN_TABLES.map((table) => [table, count(h, table)]));
const errorOf = (reply: { json: () => unknown }) => apiErrorSchema.parse(reply.json());

describe("D46.2-AC1 refusals come before the file is read and leave nothing behind", () => {
  it("answers 401 without a session, even for a body over the limit", async () => {
    const { send } = await installation({ environment: { "limits.importMaxMiB": 1 } });
    const reply = await send("x".repeat(2 * 1024 * 1024), null);
    expect([reply.status, errorOf(reply).code]).toEqual([401, "AUTH_REQUIRED"]);
  });

  it("answers 403 for a foreign Origin and for a missing one", async () => {
    const { send, h, status } = await installation();
    for (const origin of ["https://evil.example", null]) {
      const reply = await send(F01_TEXT, undefined, origin);
      expect([reply.status, errorOf(reply).code]).toEqual([403, "ORIGIN_FORBIDDEN"]);
    }
    expect(count(h, "registry")).toBe(0);
    expect((await status()).dataChoice).toBe("unselected");
  });

  it("answers 403 to a password-only session and to one whose recovery codes are not acknowledged, before the body is read", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    const proven = await installation({ environment: { "limits.importMaxMiB": 1 } });
    const stage = await proven.send(big, await proven.passwordOnly());
    expect([stage.status, errorOf(stage).code]).toEqual([403, "MFA_REQUIRED"]);
    const open = await installation({ environment: { "limits.importMaxMiB": 1 } }, false);
    const unacknowledged = await open.send(big);
    expect([unacknowledged.status, errorOf(unacknowledged).code]).toEqual([403, "RECOVERY_ACK_REQUIRED"]);
  });

  it("answers 413 for a file over the limit, writes nothing, and takes a good file afterwards", async () => {
    const { send, h, status } = await installation({ environment: { "limits.importMaxMiB": 1 } });
    const before = domainRows(h);
    const reply = await send(JSON.stringify({ ...fixture(), padding: "x".repeat(1024 * 1024) }));
    expect([reply.status, errorOf(reply).code, errorOf(reply).details]).toEqual([413, "IMPORT_TOO_LARGE", { maxBytes: 1024 * 1024 }]);
    expect(domainRows(h)).toEqual(before);
    expect((await status()).dataChoice).toBe("unselected");
    expect((await send(F01_TEXT)).status).toBe(200);
  });

  it("answers 422 with the paths and the codes of a broken file and nothing of its values", async () => {
    const { send, h, status } = await installation();
    const before = domainRows(h);
    const file = fixture();
    file["registries"][0]["columns"][1]["type"] = "no_such_type";
    file["registries"][0]["records"][0]["values"]["tytul"] = MARKER;
    file["configEntries"][0]["value"] = MARKER;
    file["unknownSection"] = MARKER;
    const reply = await send(JSON.stringify(file));
    expect([reply.status, errorOf(reply).code]).toEqual([422, "IMPORT_INVALID"]);
    const issues = (errorOf(reply).details as { issues: { path: string; code: string }[] }).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(100);
    expect(issues.map((issue) => issue.path)).toContain("unknownSection");
    expect(issues.every((issue) => typeof issue.path === "string" && /^[A-Z_]+$/.test(issue.code))).toBe(true);
    expect(reply.text).not.toContain(MARKER);
    expect(domainRows(h)).toEqual(before);
    expect((await status()).dataChoice).toBe("unselected");
  });

  it("answers 422 to text that is not JSON, to another format, and to a newer version, each with its own code", async () => {
    const { send, h, status } = await installation();
    const cases: [string, string][] = [
      ["not json at all", "EXPORT_NOT_JSON"],
      [JSON.stringify({ ...fixture(), format: "something-else" }), "EXPORT_FORMAT_UNKNOWN"],
      [JSON.stringify({ ...fixture(), formatVersion: 999 }), "EXPORT_VERSION_NEWER"],
    ];
    for (const [body, code] of cases) {
      const reply = await send(body);
      expect([reply.status, errorOf(reply).code]).toEqual([422, "IMPORT_INVALID"]);
      expect((errorOf(reply).details as { issues: { code: string }[] }).issues[0]?.code).toBe(code);
    }
    expect(count(h, "registry")).toBe(0);
    expect((await status()).dataChoice).toBe("unselected");
  });
});

describe("D46.2-AC2 the import is one choice, made once", () => {
  it("imports the export of installation A into the empty installation B and the next export is equal in canonical form", async () => {
    const a = await installation();
    await a.h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a.cookie });
    loadFixture(a.h);
    const exportedA = await a.h.request("GET", EXPORT_PATH, undefined, { cookie: a.cookie });
    expect(exportedA.status).toBe(200);

    const b = await installation();
    const reply = await b.send(exportedA.text);
    expect(reply.status).toBe(200);
    expect(importResponseSchema.parse(reply.json())).toEqual({ dataChoice: "imported", stage: "complete", imported: { configEntries: 1, dictionaries: 1, registries: 1, records: 25, screens: 1, widgets: 3 } });
    expect(reply.text).not.toMatch(/cookie|token|password/i);
    expect(await b.status()).toMatchObject({ dataChoice: "imported", stage: "complete" });
    const exportedB = await b.h.request("GET", EXPORT_PATH, undefined, { cookie: b.cookie });
    expect(canonicalOf(exportedB.text)).toBe(canonicalOf(exportedA.text));
  });

  it("lets one of two imports at once win and answers the other 409", async () => {
    const { send, h } = await installation();
    const replies = await Promise.all([send(F01_TEXT), send(F01_TEXT)]);
    const statuses = replies.map((reply) => reply.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = replies.find((reply) => reply.status === 409);
    expect(errorOf(loser ?? replies[0]!).code).toBe("SETUP_DATA_ALREADY_CHOSEN");
    expect(count(h, "registry")).toBe(1);
  });

  it("refuses a second import, an import after a start from zero, and a start from zero after an import", async () => {
    const imported = await installation();
    expect((await imported.send(F01_TEXT)).status).toBe(200);
    const again = await imported.send(F01_TEXT);
    expect([again.status, errorOf(again).code]).toEqual([409, "SETUP_DATA_ALREADY_CHOSEN"]);
    const choose = await imported.h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: imported.cookie });
    expect([choose.status, errorOf(choose).code]).toEqual([409, "SETUP_DATA_ALREADY_CHOSEN"]);
    expect(count(imported.h, "registry")).toBe(1);

    const empty = await installation();
    expect((await empty.h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: empty.cookie })).status).toBe(200);
    const late = await empty.send(F01_TEXT);
    expect([late.status, errorOf(late).code]).toEqual([409, "SETUP_DATA_ALREADY_CHOSEN"]);
    expect(count(empty.h, "registry")).toBe(0);
    expect((await empty.status()).dataChoice).toBe("empty");
  });

  it("answers 503 when the write fails, takes everything back, and takes the same file afterwards", async () => {
    const { send, h, status } = await installation();
    const before = domainRows(h);
    h.interruptNextWrite(() => {
      throw new Error("the disk is gone");
    });
    const failed = await send(F01_TEXT);
    expect([failed.status, errorOf(failed).code]).toEqual([503, "IMPORT_UNAVAILABLE"]);
    expect(failed.text).not.toContain("the disk is gone");
    expect(domainRows(h)).toEqual(before);
    expect((await status()).dataChoice).toBe("unselected");
    expect(h.logLines().some((line) => line.includes("import.unavailable"))).toBe(true);
    expect((await send(F01_TEXT)).status).toBe(200);
  });
});
