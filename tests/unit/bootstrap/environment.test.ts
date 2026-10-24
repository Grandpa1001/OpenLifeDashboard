// D03.1-AC1 — F08 cases assigned to D03.1 through the private environment parser and the built
// config-check CLI: the expected origin/updater state, or exactly the expected code and fields
// with exit code 1.
import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../../../apps/server/src/bootstrap/environment.js";
import { environmentFor, loadBootstrapCases } from "../../support/bootstrap-cases.ts";
import { CONFIG_CHECK_ENTRY, runBuiltScript } from "../../support/server-process.ts";

const fixture = loadBootstrapCases();
const cases = fixture.cases.filter((testCase) => testCase.task === "D03.1");
// An unrelated process variable must not influence the result (Architektura §14.5).
const UNRELATED = { PATH: process.env["PATH"] ?? "/usr/bin", LANG: "pl_PL.UTF-8" };

describe("F08 cases for D03.1", () => {
  it("covers every D03.1 case of the fixture", () => {
    expect(cases.map((testCase) => testCase.id)).toEqual([
      "local-defaults",
      "blank-active-environment-value",
      "numeric-value-with-unit",
      "boolean-is-not-zero-string",
      "server-with-https-origin",
      "server-rejects-http",
      "origin-rejects-subpath",
      "missing-encryption-key",
      "inactive-updater-allows-empty-placeholders",
      "active-updater-requires-token",
      "configured-updater-module-not-built-yet",
    ]);
  });

  it.each(cases)("$id: parser result", (testCase) => {
    const { env } = environmentFor(fixture, testCase);
    const result = parseEnvironment({ ...UNRELATED, ...env });
    const expected = testCase.expected;
    if (expected.kind === "ready") {
      expect(result.ok).toBe(true);
      if (result.ok) {
        if (expected.normalizedBaseUrl !== undefined) {
          expect(result.config.baseUrl).toBe(expected.normalizedBaseUrl);
        }
        if (expected.updaterEnabled !== undefined) {
          expect(result.config.updater.enabled).toBe(expected.updaterEnabled);
        }
      }
    } else {
      expect(result).toEqual({ ok: false, code: expected.code, fields: [...expected.fields].sort() });
    }
  });

  it.each([
    ["http://LOCALHOST:18080", "http://localhost:18080"],
    ["http://127.0.0.1:80/", "http://127.0.0.1"],
  ])("BASE_URL %s is normalized to %s", (raw, normalized) => {
    const { env } = environmentFor(fixture, fixture.cases[0]!);
    const result = parseEnvironment({ ...env, BASE_URL: raw });
    expect(result.ok && result.config.baseUrl).toBe(normalized);
  });

  it.each(["http://user:pw@localhost:18080", "http://localhost:18080/?q=1", "http://localhost:18080/#x", "http://example.com:18080", "https://localhost:18080"])(
    "local BASE_URL %s is rejected",
    (raw) => {
      const { env } = environmentFor(fixture, fixture.cases[0]!);
      expect(parseEnvironment({ ...env, BASE_URL: raw })).toEqual({ ok: false, code: "CONFIG_INVALID", fields: ["BASE_URL"] });
    },
  );

  it.each(cases)("$id: config-check CLI exit code and output", async (testCase) => {
    const { env } = environmentFor(fixture, testCase);
    const run = await runBuiltScript(CONFIG_CHECK_ENTRY, [], { ...UNRELATED, ...env });
    const expected = testCase.expected;
    if (expected.kind === "ready") {
      expect(run.code).toBe(0);
      expect(run.output).toContain('"event":"config.valid"');
    } else {
      expect(run.code).toBe(expected.exitCode);
      const line = JSON.parse(run.output.trim()) as { code: string; fields: string[] };
      expect(line.code).toBe(expected.code);
      expect([...line.fields].sort()).toEqual([...expected.fields].sort());
    }
  });
});
