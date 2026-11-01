// D22.3-AC2 — the validation cases of F03 (`record-validation.cases.json`) over real HTTP on the
// built server: each case on Książki of F01 gets the status and the code the fixture names, a
// refusal stores nothing, and markup stays text.
import { readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { IDEMPOTENCY_KEY_HEADER, recordSchema, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { installation, post, query, readyOwner, stopServers } from "../../support/auth-http.ts";
import { repoRoot } from "../../support/server-process.ts";
import { withoutDictionary } from "../../support/books-fixture.ts";

afterEach(async () => {
  await stopServers();
});

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[] }> };
const cases = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/cases/record-validation.cases.json"), "utf8")) as {
  registrySymbol: string;
  cases: Array<{ id: string; values: Record<string, unknown>; expectedHttpStatus: number; expectedCode?: string }>;
};
const BOOKS = fixture.registries[0]!;

describe("D22.3-AC2 the cases of F03 through the real API", () => {
  it("every case gets the status and the code of the fixture; a refusal stores nothing and markup is stored as text", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const definition = { symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })) };
    expect((await post(setup.server, REGISTRIES_PATH, definition, { cookie: owner.sessionCookie })).status).toBe(201);
    expect(cases.registrySymbol).toBe(BOOKS.symbol);
    expect(cases.cases).toHaveLength(8);

    let accepted = 0;
    for (const [index, item] of cases.cases.entries()) {
      const reply = await post(setup.server, registryRecordsPath(cases.registrySymbol), { schemaRevision: 1, values: item.values }, { cookie: owner.sessionCookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `f03-case-${String(index).padStart(3, "0")}` } });
      expect(reply.status, item.id).toBe(item.expectedHttpStatus);
      if (item.expectedCode !== undefined) expect(apiErrorSchema.parse(reply.json()).code, item.id).toBe(item.expectedCode);
      if (reply.status === 201) {
        accepted += 1;
        expect(recordSchema.parse(reply.json()).values["tytul"], item.id).toBe(item.values["tytul"]);
      }
      expect(query(setup.instance, `SELECT 1 FROM reg_${BOOKS.symbol}`), item.id).toHaveLength(accepted);
    }
    expect(accepted).toBe(cases.cases.filter((item) => item.expectedHttpStatus === 201).length);
    expect(query<{ tytul: string }>(setup.instance, `SELECT tytul FROM reg_${BOOKS.symbol} WHERE tytul LIKE '<img%'`)).toEqual([{ tytul: "<img src=x onerror=alert(1)>" }]);
  });
});
