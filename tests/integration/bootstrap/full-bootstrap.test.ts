// D03.4-AC3 — all 17 F08 cases through the real server start (main.ts: env → instance.json →
// options → storage preflight → HTTP), each on its own fresh installation, plus a scan of every
// run's output for the generated secrets. Database overrides have no store before D04, so the
// two cases that declare them also run through loadBootstrapConfig, the composition main uses.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadBootstrapConfig } from "../../../apps/server/src/bootstrap/bootstrap-config.js";
import { isJsonObject, type JsonObject } from "../../../scripts/support/workspaces.ts";
import { EVIDENCE_DIR_ENV } from "../../../tooling/verification-tasks.ts";
import { environmentFor, loadBootstrapCases, type BootstrapCase } from "../../support/bootstrap-cases.ts";
import { freshTestInstance, runServerEntry, startBuiltServer, waitForExit } from "../../support/server-process.ts";

const fixture = loadBootstrapCases();
const outputs: { id: string; output: string; secrets: readonly string[] }[] = [];

type ProcessOutcome = Readonly<{ ready?: JsonObject; failed?: JsonObject; output: string }>;

const events = (output: string): JsonObject[] =>
  output.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return isJsonObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });

async function bootCase(testCase: BootstrapCase): Promise<ProcessOutcome> {
  const installation = freshTestInstance();
  // The case's instance.json and environment replace the generated ones.
  writeFileSync(installation.instanceFile, JSON.stringify({ ...fixture.baseline.instance, ...testCase.instancePatch }));
  const { env, secrets } = environmentFor(fixture, testCase);
  const processEnv = { PATH: process.env["PATH"] ?? "", ...env };
  let output: string;
  if (testCase.expected.kind === "error") {
    const exit = await runServerEntry(["--port", "0", "--installation", installation.dir], processEnv);
    output = exit.output;
    expect(exit.code).toBe(testCase.expected.exitCode);
  } else {
    const server = await startBuiltServer({ installation: { dir: installation.dir, env: processEnv } });
    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child, server.output, 15_000);
    output = exit.output;
    expect(exit.code).toBe(0);
  }
  outputs.push({ id: testCase.id, output, secrets });
  const all = events(output);
  const failed = all.find((event) => event["event"] === "bootstrap.failed");
  const ready = all.find((event) => event["event"] === "bootstrap.ready");
  return { output, ...(ready ? { ready } : {}), ...(failed ? { failed } : {}) };
}

afterAll(() => {
  const evidenceDir = process.env[EVIDENCE_DIR_ENV];
  if (evidenceDir) {
    const summary = outputs.map(({ id, output }) => ({ id, events: events(output).map((event) => ({ event: event["event"], code: event["code"], fields: event["fields"] })) }));
    writeFileSync(path.join(evidenceDir, "full-bootstrap.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
});

describe("D03.4-AC3 every F08 case through the real server start", () => {
  it("the fixture declares 17 cases", () => {
    expect(fixture.cases).toHaveLength(17);
  });

  it.each(fixture.cases)("$id ($task)", async (testCase) => {
    const outcome = await bootCase(testCase);
    const expected = testCase.expected;
    if (expected.kind === "error") {
      const fields = outcome.failed?.["fields"];
      expect(outcome.failed?.["code"]).toBe(expected.code);
      expect(Array.isArray(fields) ? fields.map(String).sort() : fields).toEqual([...expected.fields].sort());
      expect(outcome.ready).toBeUndefined();
      return;
    }
    expect(outcome.ready, outcome.output).toBeDefined();
    if (expected.normalizedBaseUrl !== undefined) expect(outcome.ready?.["baseUrl"]).toBe(expected.normalizedBaseUrl);
    if (expected.updaterEnabled !== undefined) expect(outcome.ready?.["updaterEnabled"]).toBe(expected.updaterEnabled);
    if (expected.containerDatabasePath !== undefined) expect(outcome.ready?.["containerDatabasePath"]).toBe(expected.containerDatabasePath);
    if (expected.effectiveOption) {
      const installation = freshTestInstance();
      writeFileSync(installation.instanceFile, JSON.stringify({ ...fixture.baseline.instance, ...testCase.instancePatch }));
      const composed = loadBootstrapConfig({
        env: environmentFor(fixture, testCase).env,
        instanceFile: installation.instanceFile,
        databaseOverrides: testCase.databaseOverrides ?? {},
      });
      expect(composed.ok && composed.config.settings.find((s) => s.key === expected.effectiveOption?.key)).toEqual(expected.effectiveOption);
    }
  });

  it("no run printed any generated secret", () => {
    expect(outputs).toHaveLength(fixture.cases.length);
    for (const { id, output, secrets } of outputs) {
      expect(secrets.length, id).toBeGreaterThan(0);
      for (const secret of secrets) {
        expect(output.includes(secret), `${id} output contains a secret`).toBe(false);
      }
    }
  });
});
