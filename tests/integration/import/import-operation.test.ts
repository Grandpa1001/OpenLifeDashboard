// D46.3 — the import as an operation of the maintenance gate that leaves the instance responsive (Architektura
// §4.8, §11.4, AR12; DEV §9.43), on the in-process app of the harness over a real SQLite file, and the
// reconciliation of an import a crash left active, on a real installation.
// AC1: the gate records `import` from the moment the session passed the policy until the answer, in its phases,
//      and closes it after every outcome (200, 413, 422, 409, 503); while it runs a second import and the start
//      from zero are 503 MAINTENANCE; `health` answers while a file of 50,000 records is being imported, and
//      the longest wait for it stays within the budget of the test.
// AC2: a start with an `import` left active closes it and is ready, whichever way the import went; the parser
//      gives the same judgment in one go and with pauses, and pauses inside the records.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { HEALTH_PATH } from "@openlife/contracts/http/health";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { SETUP_IMPORT_PATH } from "@openlife/contracts/http/setup";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { parseExportFile, parseExportFileYielding, parseExportSteps } from "../../../apps/server/dist/portability/parse-export.js";
import { PARSE_RECORDS_PER_SLICE } from "../../../apps/server/dist/portability/limits.js";
import { serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { stateFile } from "../../support/database-fixtures.ts";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type HarnessOptions } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";
import { closeWriters, stopped } from "../../support/rebuild-writer.ts";
import { outputEvent } from "../../support/server-process.ts";
import { F01, F01_TEXT } from "../../support/export-fixture.ts";

afterEach(async () => {
  closeWriters();
  await closeHarnesses();
  await stopServers();
});

const LIMITS = { maxBytes: 500 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };
const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The F01 file with its registry holding `count` records (the same values, new identifiers). */
function fileWithRecords(count: number): string {
  const file = JSON.parse(F01_TEXT) as { registries: { records: { id: string }[]; dataRevision: number }[] };
  const base = file.registries[0]?.records ?? [];
  const records = Array.from({ length: count }, (_, n) => ({ ...structuredClone(base[n % base.length]), id: `019b0000-0000-7000-8000-${String(n).padStart(12, "0")}` }));
  const registry = file.registries[0];
  if (registry === undefined) throw new Error("the fixture has no registry");
  registry.records = records as typeof registry.records;
  registry.dataRevision = count;
  return JSON.stringify(file);
}

async function installation(options: HarnessOptions = {}) {
  const h = await createAppHarness({ exportAppVersion: F01.appVersion, ...options });
  const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const cookie = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie });
  const send = (body: string) => h.request("POST", SETUP_IMPORT_PATH, body, { cookie });
  return { h, cookie, send };
}

describe("D46.3-AC1 the import is an operation of the gate and the instance stays responsive", () => {
  it("records `import` while it runs, closes it after each outcome, and refuses a second import and the start from zero meanwhile", async () => {
    const { h, cookie, send } = await installation();
    const generation = h.gate.current().generation;
    const phases = new Set<string>();
    let finished = false;
    const observer = (async (): Promise<void> => {
      while (!finished) {
        const active = h.gate.current().activeOperation;
        if (active !== null) phases.add(`${active.reason}:${"phase" in active ? active.phase : ""}`);
        await pause();
      }
    })();

    const first = send(fileWithRecords(6000));
    await pause();
    const second = await send(F01_TEXT);
    const choose = await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie });
    expect([second.status, (apiErrorSchema.parse(second.json())).code]).toEqual([503, "MAINTENANCE"]);
    expect([choose.status, (apiErrorSchema.parse(choose.json())).code]).toEqual([503, "MAINTENANCE"]);
    const won = await first;
    finished = true;
    await observer;
    expect(won.status).toBe(200);
    expect([...phases].sort()).toEqual(["import:validating", "import:writing"]);
    expect(h.gate.current()).toMatchObject({ activeOperation: null, generation: generation + 1 });
  });

  it("closes the operation after a refusal of every kind and the same installation then imports", async () => {
    const { h, send } = await installation({ environment: { "limits.importMaxMiB": 1 } });
    const closed = (): boolean => h.gate.current().activeOperation === null;
    expect((await send("not json")).status).toBe(422);
    expect(closed()).toBe(true);
    expect((await send("x".repeat(2 * 1024 * 1024))).status).toBe(413);
    expect(closed()).toBe(true);
    h.interruptNextWrite(() => {
      throw new Error("the disk is gone");
    });
    expect((await send(F01_TEXT)).status).toBe(503);
    expect(closed()).toBe(true);
    expect((await send(F01_TEXT)).status).toBe(200);
    expect(closed()).toBe(true);
    expect((await send(F01_TEXT)).status).toBe(409);
    expect(closed()).toBe(true);
    // The 409 was refused by the policy before any operation began: four operations, four generations.
    expect(h.gate.current().generation).toBe(4);
  });

  it("answers health while a file of 50,000 records is imported and the longest wait stays within the budget", async () => {
    const { h, send } = await installation({ environment: { "limits.importMaxMiB": 100 } });
    const text = fileWithRecords(50_000);
    let done = false;
    // A request that waits is served when the loop is free, so what is measured is the longest time between two
    // answers of health: a block of the loop (the write of the unit) shows there even though no request was waiting.
    const answeredAt: number[] = [performance.now()];
    const polling = (async (): Promise<void> => {
      while (!done) {
        const reply = await h.request("GET", HEALTH_PATH);
        expect(reply.status).toBe(200);
        answeredAt.push(performance.now());
        await pause();
      }
    })();
    const started = performance.now();
    const reply = await send(text);
    // The moment the answer came counts as one more point, so a block of the loop just before it is not lost.
    answeredAt.push(performance.now());
    const total = answeredAt.at(-1)! - started;
    done = true;
    await polling;
    expect(reply.status).toBe(200);
    // Health was answered between the steps of the parser, not only before and after the import.
    expect(answeredAt.length).toBeGreaterThanOrEqual(10);
    const longest = Math.max(...answeredAt.slice(1).map((at, index) => at - (answeredAt[index] ?? at)));
    console.log(`import of 50,000 records: ${Math.round(total)} ms, ${answeredAt.length - 1} answers of health, longest gap between two answers ${Math.round(longest)} ms`);
    expect(longest).toBeLessThan(3000);
  });
});

describe("D46.3-AC2 the parser pauses and an import left active by a crash is reconciled", () => {
  it("judges a file the same in one go and with pauses, and pauses inside the records", async () => {
    const text = fileWithRecords(PARSE_RECORDS_PER_SLICE * 2 + 10);
    const oneGo = parseExportFile(text, LIMITS);
    let pauses = 0;
    const withPauses = await parseExportFileYielding(text, LIMITS, async () => {
      pauses += 1;
      await pause();
    });
    expect(oneGo.ok).toBe(true);
    expect(withPauses).toEqual(oneGo);
    // The stages (before the JSON, before the shape, before the rules) and the two slices boundaries inside the records.
    expect(pauses).toBeGreaterThanOrEqual(5);

    const broken = JSON.parse(text) as { registries: { records: { values: Record<string, unknown> }[] }[] };
    const last = broken.registries[0]?.records.at(-1);
    if (last === undefined) throw new Error("no record");
    last.values["tytul"] = 12;
    const bad = JSON.stringify(broken);
    const steps = parseExportSteps(bad, LIMITS);
    let result = steps.next();
    while (!result.done) result = steps.next();
    expect(result.value).toEqual(parseExportFile(bad, LIMITS));
    expect(result.value.ok).toBe(false);
  });

  const readGate = (setup: Installation) => JSON.parse(readFileSync(stateFile(setup.instance), "utf8")) as { formatVersion: number; generation: number; activeOperation: Record<string, unknown> | null };

  it("closes an `import` left active in either phase and the server is ready", async () => {
    for (const phase of ["validating", "writing"]) {
      const { setup } = await stopped("d46-3");
      const state = readGate(setup);
      writeFileSync(stateFile(setup.instance), JSON.stringify({ formatVersion: 1, generation: state.generation + 1, activeOperation: { operationId: randomUUID(), reason: "import", phase, startedAt: new Date().toISOString() } }));
      const server = await serve(setup.instance);
      expect(outputEvent(server.output(), "bootstrap.ready")).toMatchObject({ maintenance: { generation: state.generation + 1 } });
      await stopServer(server);
      expect(readGate(setup)).toEqual({ formatVersion: 1, generation: state.generation + 1, activeOperation: null });
    }
  });
});
