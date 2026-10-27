// D15.1 — the rules of one record (Architektura §4.5, §4.6, §18.1) on the schema of F01 and the
// cases of record-validation.cases.json. AC1: the cases of the fixture and the defaults; AC2: every
// type, the limits on their edge, all problems at once, the canonical text of a request.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalRecordRequest,
  resolveSortColumn,
  validateRecordValues,
  type RecordPolicy,
  type RecordSchema,
} from "../../../packages/core/dist/modules/registries/public.js";
import { repoRoot } from "../../support/server-process.ts";

type FixtureColumn = { symbol: string; type: string; typeOptions: Record<string, number>; defaultValue: unknown; required: boolean };
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(repoRoot, file), "utf8")) as T;
const books = read<{ registries: Array<{ schemaRevision: number; columns: FixtureColumn[] }> }>("tests/fixtures/books/books-v1.export.json").registries[0]!;
const SCHEMA = { schemaRevision: books.schemaRevision, columns: books.columns } as unknown as RecordSchema;
const POLICY: RecordPolicy = { maxTextCodePoints: 10_000, maxRecordBytes: 192 * 1024 };
const check = (values: unknown, policy: RecordPolicy = POLICY) => validateRecordValues(SCHEMA, values, policy);
const issuesOf = (values: unknown, policy: RecordPolicy = POLICY) => {
  const result = check(values, policy);
  return result.ok ? [] : result.issues;
};

describe("D15.1-AC1 the cases of the fixture and the defaults", () => {
  const cases = read<{ cases: Array<{ id: string; values: unknown; expectedHttpStatus: number }> }>("tests/fixtures/cases/record-validation.cases.json").cases;
  it("the fixture has the eight cases this step is checked against", () => {
    expect(cases.map((item) => item.id)).toEqual(["missing-title", "invalid-date", "fractional-amount", "invalid-boolean", "unexpected-system-field", "unknown-column", "unknown-dictionary-value", "xss-stays-text"]);
  });
  for (const item of cases) {
    it(`${item.id}: ${item.expectedHttpStatus === 201 ? "accepted" : "refused"}`, () => {
      expect(check(item.values).ok).toBe(item.expectedHttpStatus === 201);
    });
  }

  it("each refusal names its field and its reason", () => {
    expect(issuesOf({})).toEqual([{ path: "values.tytul", code: "VALUE_REQUIRED" }]);
    expect(issuesOf({ tytul: "T", data_ukonczenia: "2026-02-31" })).toEqual([{ path: "values.data_ukonczenia", code: "VALUE_INVALID" }]);
    expect(issuesOf({ tytul: "T", cena: 10.37 })).toEqual([{ path: "values.cena", code: "VALUE_INVALID" }]);
    expect(issuesOf({ tytul: "T", ponowne_czytanie: "tak" })).toEqual([{ path: "values.ponowne_czytanie", code: "VALUE_INVALID" }]);
    expect(issuesOf({ tytul: "T", user_id: "foreign-owner" })).toEqual([{ path: "values.user_id", code: "FIELD_SYSTEM" }]);
    expect(issuesOf({ tytul: "T", nieistniejaca: "x" })).toEqual([{ path: "values.nieistniejaca", code: "FIELD_UNKNOWN" }]);
    for (const system of ["id", "user_id", "created_at", "updated_at", "revision"]) expect(issuesOf({ tytul: "T", [system]: "x" })).toEqual([{ path: `values.${system}`, code: "FIELD_SYSTEM" }]);
  });

  it("a column left out takes the default of the catalog, a null given stays null, a value given wins", () => {
    const left = check({ tytul: "Nowa książka" });
    expect(left.ok && left.values).toEqual({ tytul: "Nowa książka", autor: null, strony: null, cena: null, data_ukonczenia: null, rozpoczeto: null, przypomnienie: null, ponowne_czytanie: false, status: "planowane" });
    const explicit = check({ tytul: "T", status: null, ponowne_czytanie: null });
    expect(explicit.ok && [explicit.values["status"], explicit.values["ponowne_czytanie"]]).toEqual([null, null]);
    const given = check({ tytul: "T", status: "przeczytane", ponowne_czytanie: true });
    expect(given.ok && [given.values["status"], given.values["ponowne_czytanie"]]).toEqual(["przeczytane", true]);
  });

  it("a whole record of F01 is accepted as it is", () => {
    const fixture = read<{ registries: Array<{ records: Array<{ values: unknown }> }> }>("tests/fixtures/books/books-v1.export.json").registries[0]!;
    for (const record of fixture.records) expect(check(record.values).ok, JSON.stringify(record.values)).toBe(true);
  });
});

describe("D15.1-AC2 types, limits, all problems, the canonical text", () => {
  it("a required column is not null, not empty and not only white space; an optional text may be", () => {
    for (const title of [null, "", " ", "   ", "\t\n", " ", "  　"]) expect(issuesOf({ tytul: title }), JSON.stringify(title)).toEqual([{ path: "values.tytul", code: "VALUE_REQUIRED" }]);
    expect(check({ tytul: " x " }).ok).toBe(true);
    expect(check({ tytul: "T", autor: "   " }).ok).toBe(true);
    expect(check({ tytul: "T", autor: "" }).ok).toBe(true);
  });

  it("every type takes its canonical values and refuses the others", () => {
    const good: Array<[string, unknown]> = [["strony", 10], ["strony", 0], ["cena", 1037], ["cena", -5], ["data_ukonczenia", "2028-02-29"], ["rozpoczeto", "2026-10-01T12:01:00Z"], ["przypomnienie", "23:59"], ["ponowne_czytanie", true], ["status", "cokolwiek"], ["autor", "Zażółć gęślą jaźń"]];
    const bad: Array<[string, unknown]> = [["strony", 10.5], ["strony", "10"], ["strony", Number.NaN], ["cena", "10,37"], ["cena", 1e300], ["data_ukonczenia", "2027-02-29"], ["data_ukonczenia", "28.02.2026"], ["rozpoczeto", "2026-10-01"], ["rozpoczeto", "2026-10-01T12:01:00+02:00"], ["przypomnienie", "24:00"], ["ponowne_czytanie", 1], ["ponowne_czytanie", "true"], ["status", ""], ["status", 5], ["autor", 5], ["autor", { a: 1 }], ["autor", ["x"]]];
    for (const [symbol, value] of good) expect(check({ tytul: "T", [symbol]: value }).ok, `${symbol} ${JSON.stringify(value)}`).toBe(true);
    for (const [symbol, value] of bad) expect(issuesOf({ tytul: "T", [symbol]: value }), `${symbol} ${String(value)}`).toEqual([{ path: `values.${symbol}`, code: "VALUE_INVALID" }]);
  });

  it("the text limit counts code points, on its edge", () => {
    const emoji = (count: number) => "😀".repeat(count);
    expect(check({ tytul: emoji(10_000) }).ok).toBe(true);
    expect(issuesOf({ tytul: emoji(10_001) })).toEqual([{ path: "values.tytul", code: "VALUE_INVALID" }]);
    expect(issuesOf({ tytul: "T", autor: "a".repeat(11) }, { ...POLICY, maxTextCodePoints: 10 })).toEqual([{ path: "values.autor", code: "VALUE_INVALID" }]);
    expect(check({ tytul: "T", autor: "a".repeat(10) }, { ...POLICY, maxTextCodePoints: 10 }).ok).toBe(true);
  });

  it("the record limit counts UTF-8 bytes of the stored values, on its edge", () => {
    const values = { tytul: "Zażółć" };
    const accepted = check(values);
    if (!accepted.ok) throw new Error("the record should be valid");
    const size = Buffer.byteLength(JSON.stringify(accepted.values), "utf8");
    expect(check(values, { ...POLICY, maxRecordBytes: size }).ok).toBe(true);
    expect(issuesOf(values, { ...POLICY, maxRecordBytes: size - 1 })).toEqual([{ path: "values", code: "RECORD_TOO_LARGE" }]);
  });

  it("every problem is returned at once: system and unknown fields first, then the columns in the order of the schema", () => {
    expect(issuesOf({ user_id: "x", zzz: 1, cena: 1.5, ponowne_czytanie: "tak" })).toEqual([
      { path: "values.user_id", code: "FIELD_SYSTEM" },
      { path: "values.zzz", code: "FIELD_UNKNOWN" },
      { path: "values.tytul", code: "VALUE_REQUIRED" },
      { path: "values.cena", code: "VALUE_INVALID" },
      { path: "values.ponowne_czytanie", code: "VALUE_INVALID" },
    ]);
  });

  it("anything but a plain object is refused, and a __proto__ key is an unknown field that pollutes nothing", () => {
    for (const input of [null, undefined, [], ["tytul"], "x", 5, true, new Date(), Object.create(null)]) expect(issuesOf(input), Object.prototype.toString.call(input)).toEqual([{ path: "values", code: "VALUES_NOT_OBJECT" }]);
    expect(issuesOf(JSON.parse('{"tytul":"T","__proto__":{"polluted":true},"constructor":1}'))).toEqual([
      { path: "values.__proto__", code: "FIELD_UNKNOWN" },
      { path: "values.constructor", code: "FIELD_UNKNOWN" },
    ]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const result = check({ tytul: "T" });
    expect(result.ok && Object.keys(result.values)).toEqual(["tytul", "autor", "strony", "cena", "data_ukonczenia", "rozpoczeto", "przypomnienie", "ponowne_czytanie", "status"]);
  });

  it("the canonical text of a request does not depend on the order of the keys and differs for different input", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: null } })).toBe('{"a":{"c":null,"d":[3,2]},"b":1}');
    const a = canonicalRecordRequest(1, { tytul: "T", autor: "A" });
    expect(canonicalRecordRequest(1, { autor: "A", tytul: "T" })).toBe(a);
    for (const other of [canonicalRecordRequest(2, { tytul: "T", autor: "A" }), canonicalRecordRequest(1, { tytul: "T", autor: "B" }), canonicalRecordRequest(1, { tytul: "T" }), canonicalRecordRequest(1, { tytul: "T", autor: null }), canonicalRecordRequest(1, { tytul: "T", autor: "A", strony: 1 })]) expect(other).not.toBe(a);
    expect(canonicalRecordRequest(1, { n: 1 })).not.toBe(canonicalRecordRequest(1, { n: "1" }));
  });

  it("a list may be sorted by a system column or a column of the registry, and by nothing else", () => {
    const columns = books.columns;
    expect(resolveSortColumn(columns, "created_at")).toEqual({ kind: "system", symbol: "created_at" });
    expect(resolveSortColumn(columns, "updated_at")).toEqual({ kind: "system", symbol: "updated_at" });
    expect(resolveSortColumn(columns, "id")).toEqual({ kind: "system", symbol: "id" });
    expect(resolveSortColumn(columns, "tytul")).toEqual({ kind: "column", symbol: "tytul" });
    for (const hostile of ["", "user_id", "revision", "Tytul", "tytul ", 'tytul"; DROP TABLE x; --', "tytul,id", "constructor", "__proto__", "1", "*"]) expect(resolveSortColumn(columns, hostile), JSON.stringify(hostile)).toBeNull();
  });

  it("the rules read nothing from outside", () => {
    const source = readFileSync(path.join(repoRoot, "packages/core/src/modules/registries/domain/record-rules.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|Date\.now|Math\.random|new Date\(|from "node:/);
  });
});
