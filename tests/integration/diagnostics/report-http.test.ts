// D44.3 — the diagnostic report over HTTP, on the in-process app of the harness (Architektura §15.3; DEV §9.41).
// AC1: no session is 401 and a session that has not passed the gate is refused; the report is one JSON file
//      downloaded as an attachment, in the shape of the contract: the overview, the options of the catalog
//      with their source, and the list of the log files; it is the same as the overview where they overlap.
// AC2: what the owner keeps in the application is not in it: the name and the records of a registry, an
//      entry of ConfigTable, the audit with its values, the lines of the log, a secret that went through a
//      request; the options are the catalog's and no key of the environment is added.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { DIAGNOSTICS_PATH, DIAGNOSTICS_REPORT_PATH, diagnosticReportSchema, diagnosticsSchema } from "@openlife/contracts/http/diagnostics";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

const MARKER = "MARKER-report-secret-5be90d";

async function owner(environment: Record<string, unknown> = {}) {
  const h = await createAppHarness({ environment });
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  const report = (cookie: string | null = a) => h.request("GET", DIAGNOSTICS_REPORT_PATH, undefined, { cookie });
  return { h, a, report, issued, passwordOnly: async () => (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "" };
}

describe("D44.3-AC1 the gate and the shape of the report", () => {
  it("answers 401 without a session and the code of the gate before the session has passed it", async () => {
    const { report, passwordOnly } = await owner();
    const anonymous = await report(null);
    expect([anonymous.status, apiErrorSchema.parse(anonymous.json()).code]).toEqual([401, "AUTH_REQUIRED"]);
    const early = await report(await passwordOnly());
    expect([early.status, apiErrorSchema.parse(early.json()).code]).toEqual([403, "MFA_REQUIRED"]);
  });

  it("is one JSON file for download with the overview, the options of the catalog with their source and the log files", async () => {
    const { h, a } = await owner({ "limits.importMaxMiB": 200 });
    writeFileSync(path.join(h.logsDir, "app.jsonl"), JSON.stringify({ level: "info", event: "http.request", requestId: "r-1" }) + "\n");
    const response = await h.open(DIAGNOSTICS_REPORT_PATH, { cookie: a });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="openlife-diagnostics.json"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const report = diagnosticReportSchema.parse(JSON.parse(text));
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["formatVersion", "generatedAt", "logFiles", "options", "overview"]);
    expect(report.options.map((option) => option.key)).toEqual(SETTINGS_CATALOG.map((definition) => definition.key));
    expect(report.options.find((option) => option.key === "limits.importMaxMiB")).toEqual({ key: "limits.importMaxMiB", value: 200, source: "env" });
    expect(report.options.find((option) => option.key === "tables.defaultPageSize")?.source).toBe("default");
    expect(report.logFiles.map((file) => file.name)).toEqual(["app.jsonl"]);
    const overview = diagnosticsSchema.parse((await h.request("GET", DIAGNOSTICS_PATH, undefined, { cookie: a })).json());
    expect(report.overview.app).toEqual(overview.app);
    expect(report.overview.paths).toEqual(overview.paths);
  });
});

describe("D44.3-AC2 what the owner keeps is not in the report", () => {
  it("holds nothing of the registries, the records, ConfigTable, the audit, the log lines or the secrets that went through requests", async () => {
    const { h, a, report, issued } = await owner();
    const registry = await h.request(
      "POST",
      "/api/v1/registries",
      { symbol: "notatki", displayName: `Notatki ${MARKER}`, columns: [{ symbol: "tytul", displayName: "Tytuł", type: "text", typeOptions: {}, defaultValue: null, required: false }] },
      { cookie: a },
    );
    expect(registry.status).toBe(201);
    expect((await h.request("POST", "/api/v1/registries/notatki/records", { schemaRevision: 1, values: { tytul: MARKER } }, { cookie: a, headers: { "Idempotency-Key": "d44-3-key-1" } })).status).toBe(201);
    expect((await h.request("POST", "/api/v1/config", { symbol: "klucz", displayName: "Klucz", value: MARKER }, { cookie: a })).status).toBe(201);
    // A failure of the log with the marker in its message, a wrong password and a wrong code carrying it.
    writeFileSync(path.join(h.logsDir, "app.jsonl"), JSON.stringify({ timestamp: "2026-11-12T10:00:00.000Z", level: "error", event: "x.failed", code: "X_FAILED", requestId: "r-2", error: { message: MARKER } }) + "\n");
    await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: MARKER });
    await h.request("POST", "/api/v1/mfa/verify", { recoveryCode: MARKER }, { cookie: a });

    const reply = await report();
    expect(reply.status).toBe(200);
    expect(reply.text).not.toContain(MARKER);
    // The recovery codes, the TOTP secret's key material and the session cookie are not in it either.
    for (const code of issued.recoveryCodes) expect(reply.text).not.toContain(code);
    expect(reply.text).not.toContain(a.slice(a.indexOf("=") + 1));
    expect(reply.text).not.toContain(HARNESS_EMAIL);
    expect(reply.text).not.toContain(HARNESS_PASSWORD);
    const parsed = diagnosticReportSchema.parse(JSON.parse(reply.text));
    // The error is there only as the four fields.
    expect(parsed.overview.recentErrors).toEqual([{ at: "2026-11-12T10:00:00.000Z", event: "x.failed", code: "X_FAILED", requestId: "r-2" }]);
  });

  it("writes only the options of the catalog, whatever else the environment holds", async () => {
    const { report } = await owner({ "limits.importMaxMiB": 200 });
    const parsed = diagnosticReportSchema.parse(JSON.parse((await report()).text));
    expect(new Set(parsed.options.map((option) => option.key))).toEqual(new Set(SETTINGS_CATALOG.map((definition) => definition.key)));
    expect(JSON.stringify(parsed)).not.toMatch(/SECRET|ENCRYPTION|BETTER_AUTH|\.env/i);
  });
});
