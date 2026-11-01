// D26.1 — a change of the structure before anything is changed (Scope §5.6, S8, S9; Architektura
// §4.3, §4.5, §4.6, §5.2), as pure functions on Książki of F01.
// AC1: S9 — "12" and "abc" of a text column become 12 and a failure as numbers; every supported pair
//      on a table of cases, exact (no rounding, no SQLite cast), a date is a real day and a day of
//      the owner's zone across midnight and the changes of the clock, a date-time without a zone
//      does not convert; the report counts and keeps the most frequent failures first.
// AC2: an unsupported pair, a column of another registry, the symbol of a column, a bad new column
//      and a replacement of the wrong type are refused with their paths; a required column that
//      would lose values or keep empty cells is blocked; a plan of another revision is stale, and
//      after its time it is expired.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessChange,
  canonicalChange,
  convertCell,
  conversionOf,
  DEFAULT_REGISTRY_LIMITS,
  planState,
  reportConversion,
  STRUCTURE_PLAN_TTL_MS,
  validateStructureChange,
  type CellValue,
  type ColumnType,
  type ColumnTypeOptions,
  type StructureChange,
  type StructureColumn,
  type StructureSchema,
} from "../../../packages/core/dist/modules/registries/public.js";

const root = path.resolve(import.meta.dirname, "../../..");
type FixtureColumn = { id: string; symbol: string; displayName: string; type: ColumnType; typeOptions: ColumnTypeOptions; defaultValue: CellValue; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(root, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ id: string; columns: FixtureColumn[]; records: Array<{ values: Record<string, CellValue> }> }> };
const BOOKS = fixture.registries[0]!;
const COLUMNS: StructureColumn[] = BOOKS.columns.map(({ id, symbol, displayName, type, typeOptions, defaultValue, required }) => ({ id, symbol, displayName, type, typeOptions: type === "choice" ? {} : typeOptions, defaultValue, required }));
const SCHEMA: StructureSchema = { registryId: BOOKS.id, columns: COLUMNS };
const CONTEXT = { limits: DEFAULT_REGISTRY_LIMITS, dictionaryIds: new Set<string>() };
const ZONE = { timeZone: "Europe/Warsaw", textMaxCodePoints: 10_000 };
const col = (symbol: string): StructureColumn => COLUMNS.find((each) => each.symbol === symbol)!;
const T = (type: ColumnType, typeOptions: ColumnTypeOptions = {}) => ({ type, typeOptions });
const issuesOf = (draft: unknown, schema: StructureSchema = SCHEMA) => {
  const result = validateStructureChange(draft, schema, CONTEXT);
  return result.ok ? [] : result.issues;
};
const changeOf = (draft: unknown): StructureChange => {
  const result = validateStructureChange(draft, SCHEMA, CONTEXT);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
};

describe("D26.1-AC1 conversions", () => {
  it("S9: \"12\" and \"abc\" of a text column as numbers are 12 and a failure; the report says so", () => {
    expect(convertCell("12", T("text"), T("number"), ZONE)).toEqual({ ok: true, value: 12 });
    expect(convertCell("abc", T("text"), T("number"), ZONE)).toEqual({ ok: false });
    const change = changeOf({ kind: "changeType", columnId: col("autor").id, type: "number", typeOptions: { decimalPlaces: 0 } });
    if (change.kind !== "changeType") throw new Error("not a type change");
    const report = reportConversion(["12", "abc", null], conversionOf(col("autor"), change, ZONE));
    expect(report).toEqual({ converted: 1, unchanged: 0, empty: 1, failed: 1, samples: [{ value: "abc", count: 1 }] });
  });

  it("every supported pair on a table of cases, exactly or not at all", () => {
    const cases: Array<[CellValue, ReturnType<typeof T>, ReturnType<typeof T>, CellValue | "fails"]> = [
      // text → number, money: a decimal comma or point, spaces between groups; never a rounding.
      [" 1 234,5 ", T("text"), T("number", { decimalPlaces: 1 }), 1234.5],
      ["12,55", T("text"), T("number", { decimalPlaces: 1 }), "fails"],
      ["12.50", T("text"), T("number", { decimalPlaces: 1 }), 12.5],
      ["1e3", T("text"), T("number"), "fails"],
      ["10,37", T("text"), T("money"), 1037],
      ["-0.5", T("text"), T("money"), -50],
      ["10.375", T("text"), T("money"), "fails"],
      ["90071992547409.92", T("text"), T("money"), "fails"],
      ["90071992547409.91", T("text"), T("money"), 9007199254740991],
      // text → date, time, date-time, yes/no.
      ["2026-02-28", T("text"), T("date"), "2026-02-28"],
      ["2026-02-31", T("text"), T("date"), "fails"],
      [" 07:05 ", T("text"), T("time"), "07:05"],
      ["7:05", T("text"), T("time"), "fails"],
      ["2026-03-15T08:30+01:00", T("text"), T("datetime"), "2026-03-15T07:30:00.000Z"],
      ["2026-03-15 08:30:15.5Z", T("text"), T("datetime"), "2026-03-15T08:30:15.500Z"],
      ["2026-03-15T08:30", T("text"), T("datetime"), "fails"],
      ["2026-02-30T08:30Z", T("text"), T("datetime"), "fails"],
      [" TAK ", T("text"), T("boolean"), true],
      ["no", T("text"), T("boolean"), false],
      ["może", T("text"), T("boolean"), "fails"],
      // To text and choice: the canonical text of the value; an empty text is no choice.
      [12.5, T("number", { decimalPlaces: 2 }), T("text"), "12.5"],
      [1e21, T("number"), T("text"), "1000000000000000000000"],
      [-1037, T("money"), T("text"), "-10.37"],
      [true, T("boolean"), T("choice"), "true"],
      ["2026-03-15T07:30:00.000Z", T("datetime"), T("text"), "2026-03-15T07:30:00.000Z"],
      ["planowane", T("choice"), T("text"), "planowane"],
      ["", T("text"), T("choice"), "fails"],
      // Numbers and amounts: exactly.
      [10.37, T("number", { decimalPlaces: 2 }), T("money"), 1037],
      [10.375, T("number", { decimalPlaces: 3 }), T("money"), "fails"],
      [1037, T("money"), T("number", { decimalPlaces: 2 }), 10.37],
      [1037, T("money"), T("number", { decimalPlaces: 1 }), "fails"],
      [1030, T("money"), T("number", { decimalPlaces: 1 }), 10.3],
      [12.25, T("number", { decimalPlaces: 2 }), T("number", { decimalPlaces: 1 }), "fails"],
      [12.2, T("number", { decimalPlaces: 2 }), T("number", { decimalPlaces: 1 }), 12.2],
      [true, T("boolean"), T("number"), 1],
      // Days of the owner's zone: midnight in Warsaw is the evening before in UTC, also on the day of 23 hours.
      ["2026-03-29", T("date"), T("datetime"), "2026-03-28T23:00:00.000Z"],
      ["2026-03-30", T("date"), T("datetime"), "2026-03-29T22:00:00.000Z"],
      ["2026-10-25T22:30:00.000Z", T("datetime"), T("date"), "2026-10-25"],
      ["2026-10-25T23:30:00.000Z", T("datetime"), T("date"), "2026-10-26"],
      [null, T("text"), T("number"), null],
    ];
    for (const [value, from, to, expected] of cases) {
      const label = `${JSON.stringify(value)} ${from.type}${JSON.stringify(from.typeOptions)} → ${to.type}${JSON.stringify(to.typeOptions)}`;
      expect(convertCell(value, from, to, ZONE), label).toEqual(expected === "fails" ? { ok: false } : { ok: true, value: expected });
    }
    // The day of a date-time is the owner's: the same instant is another day in New York.
    expect(convertCell("2026-10-25T23:30:00.000Z", T("datetime"), T("date"), { ...ZONE, timeZone: "America/New_York" })).toEqual({ ok: true, value: "2026-10-25" });
    // A pair with no meaning does not convert, whatever the value.
    for (const [value, from, to] of [[5, T("number"), T("date")], [true, T("boolean"), T("money")], ["07:05", T("time"), T("datetime")], ["2026-01-01", T("date"), T("time")]] as const) expect(convertCell(value, from, to, ZONE)).toEqual({ ok: false });
  });

  it("the report goes once over the values and keeps the twenty most frequent failures, the most frequent first", () => {
    const values: CellValue[] = [];
    for (let index = 0; index < 30; index += 1) for (let repeat = 0; repeat <= index % 3; repeat += 1) values.push(`zle_${String(index).padStart(2, "0")}`);
    values.push("1", "2", null, null);
    let calls = 0;
    const report = reportConversion(values, (value) => {
      calls += 1;
      return convertCell(value, T("text"), T("number"), ZONE);
    });
    expect(calls).toBe(values.length - 2);
    expect(report).toMatchObject({ converted: 2, unchanged: 0, empty: 2, failed: 60 });
    expect(report.samples).toHaveLength(20);
    expect(report.samples.slice(0, 3)).toEqual([{ value: "zle_02", count: 3 }, { value: "zle_05", count: 3 }, { value: "zle_08", count: 3 }]);
    expect(report.samples.map((each) => each.count)).toEqual([...report.samples.map((each) => each.count)].sort((a, b) => b - a));
    // A value that stays as it was is not a conversion.
    expect(reportConversion(["a", "b"], (value) => convertCell(value, T("text"), T("choice"), ZONE))).toMatchObject({ converted: 0, unchanged: 2 });
  });
});

describe("D26.1-AC2 the rules of a change", () => {
  it("each kind of change in its normalized form, bound by a canonical text", () => {
    expect(changeOf({ kind: "renameColumn", columnId: col("autor").id, displayName: "  Autorka " })).toEqual({ kind: "renameColumn", columnId: col("autor").id, displayName: "Autorka" });
    expect(changeOf({ kind: "removeColumn", columnId: col("autor").id })).toEqual({ kind: "removeColumn", columnId: col("autor").id });
    expect(changeOf({ kind: "changeType", columnId: col("strony").id, type: "text" })).toEqual({ kind: "changeType", columnId: col("strony").id, type: "text", typeOptions: {}, required: false, replacement: null });
    expect(changeOf({ kind: "setRequired", columnId: col("autor").id, required: true, replacement: "Nieznany" })).toEqual({ kind: "setRequired", columnId: col("autor").id, required: true, replacement: "Nieznany" });
    expect(changeOf({ kind: "deleteRegistry" })).toEqual({ kind: "deleteRegistry" });
    const added = changeOf({ kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", typeOptions: { decimalPlaces: 1 }, required: true, defaultValue: 3 } });
    expect(added).toEqual({ kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", typeOptions: { decimalPlaces: 1 }, required: true, defaultValue: 3, position: COLUMNS.length } });
    expect(canonicalChange(changeOf({ columnId: col("autor").id, kind: "removeColumn" }))).toBe(canonicalChange(changeOf({ kind: "removeColumn", columnId: col("autor").id })));
  });

  it("an unknown kind or column, the last column, a symbol taken or reserved, an unsupported pair, no change at all and a replacement of the wrong type are refused with their paths", () => {
    expect(issuesOf({ kind: "renameSymbol", columnId: col("autor").id, symbol: "pisarz" })).toEqual([{ path: "kind", code: "CHANGE_UNKNOWN" }]);
    expect(issuesOf({ kind: "removeColumn", columnId: "019a0000-0000-7000-8000-000000000999" })).toEqual([{ path: "columnId", code: "COLUMN_UNKNOWN" }]);
    expect(issuesOf({ kind: "removeColumn", columnId: col("tytul").id }, { ...SCHEMA, columns: [col("tytul")] })).toEqual([{ path: "columnId", code: "COLUMN_LAST" }]);
    expect(issuesOf({ kind: "addColumn", column: { symbol: "autor", displayName: "Autor 2", type: "text" } })).toEqual([{ path: "column.symbol", code: "SYMBOL_TAKEN" }]);
    expect(issuesOf({ kind: "addColumn", column: { symbol: "rowid", displayName: "Wiersz", type: "text" } })).toEqual([{ path: "column.symbol", code: "SYMBOL_RESERVED" }]);
    expect(issuesOf({ kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", defaultValue: "3" } })).toEqual([{ path: "column.defaultValue", code: "DEFAULT_INVALID" }]);
    expect(issuesOf({ kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "text" } }, { ...SCHEMA, columns: Array.from({ length: 60 }, (_, index) => ({ ...col("autor"), id: `c${index}`, symbol: `k${index}` })) })).toEqual([{ path: "column", code: "LIMIT_COLUMNS" }]);
    expect(issuesOf({ kind: "changeType", columnId: col("strony").id, type: "date" })).toEqual([{ path: "type", code: "TYPE_CHANGE_UNSUPPORTED" }]);
    expect(issuesOf({ kind: "changeType", columnId: col("strony").id, type: "number", typeOptions: { decimalPlaces: 0 } })).toEqual([{ path: "type", code: "CHANGE_EMPTY" }]);
    expect(issuesOf({ kind: "changeType", columnId: col("strony").id, type: "number", typeOptions: { decimalPlaces: 9 } })).toEqual([{ path: "typeOptions", code: "TYPE_OPTIONS_INVALID" }]);
    expect(issuesOf({ kind: "changeType", columnId: col("autor").id, type: "choice", typeOptions: { dictionaryId: "obcy" } })).toEqual([{ path: "typeOptions.dictionaryId", code: "DICTIONARY_UNKNOWN" }]);
    expect(issuesOf({ kind: "changeType", columnId: col("autor").id, type: "number", required: true, replacement: "zero" })).toEqual([{ path: "replacement", code: "REPLACEMENT_INVALID" }]);
    expect(issuesOf({ kind: "setRequired", columnId: col("tytul").id, required: true })).toEqual([{ path: "required", code: "CHANGE_EMPTY" }]);
    expect(issuesOf({ kind: "setRequired", columnId: col("strony").id, required: true, replacement: "dużo" })).toEqual([{ path: "replacement", code: "REPLACEMENT_INVALID" }]);
    expect(issuesOf({ kind: "renameColumn", columnId: col("autor").id, displayName: "Autor" })).toEqual([{ path: "displayName", code: "CHANGE_EMPTY" }]);
    expect(issuesOf("removeColumn")).toEqual([{ path: "kind", code: "CHANGE_UNKNOWN" }]);
  });

  it("the records a change touches, and a required column that would lose values or keep empty cells is blocked", () => {
    const records = BOOKS.records.length;
    const typeChange = (required: boolean, replacement: CellValue = null) => changeOf({ kind: "changeType", columnId: col("autor").id, type: "number", required, replacement });
    const conversion = { converted: 1, unchanged: 0, empty: 1, failed: 1, samples: [{ value: "abc", count: 1 }] };
    expect(assessChange(typeChange(false), { records, conversion })).toEqual({ affected: 2, blocked: null });
    expect(assessChange(typeChange(true), { records, conversion })).toEqual({ affected: 2, blocked: "REQUIRED_VALUES_LOST" });
    expect(assessChange(typeChange(true), { records, conversion: { ...conversion, failed: 0, samples: [] } })).toEqual({ affected: 1, blocked: "REQUIRED_EMPTY" });
    expect(assessChange(typeChange(true, 0), { records, conversion })).toEqual({ affected: 3, blocked: null });
    expect(assessChange(changeOf({ kind: "removeColumn", columnId: col("autor").id }), { records, column: { values: 20, empty: 5 } })).toEqual({ affected: 20, blocked: null });
    expect(assessChange(changeOf({ kind: "setRequired", columnId: col("autor").id, required: true }), { records, column: { values: 20, empty: 5 } })).toEqual({ affected: 0, blocked: "REQUIRED_EMPTY" });
    expect(assessChange(changeOf({ kind: "setRequired", columnId: col("autor").id, required: true, replacement: "?" }), { records, column: { values: 20, empty: 5 } })).toEqual({ affected: 5, blocked: null });
    const required = (defaultValue: CellValue) => changeOf({ kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", required: true, defaultValue } });
    expect(assessChange(required(null), { records })).toEqual({ affected: 0, blocked: "REQUIRED_EMPTY" });
    expect(assessChange(required(null), { records: 0 })).toEqual({ affected: 0, blocked: null });
    expect(assessChange(required(3), { records })).toEqual({ affected: records, blocked: null });
    expect(assessChange(changeOf({ kind: "deleteRegistry" }), { records })).toEqual({ affected: records, blocked: null });
  });

  it("a plan is current while it lasts and the registry has both its revisions; a new record makes it stale", () => {
    const claims = { registryId: BOOKS.id, schemaRevision: 1, dataRevision: 25, expiresAtMs: 1_000 + STRUCTURE_PLAN_TTL_MS };
    expect(STRUCTURE_PLAN_TTL_MS).toBe(600_000);
    expect(planState(claims, { schemaRevision: 1, dataRevision: 25 }, 1_000)).toBe("current");
    expect(planState(claims, { schemaRevision: 1, dataRevision: 26 }, 1_000)).toBe("stale");
    expect(planState(claims, { schemaRevision: 2, dataRevision: 25 }, 1_000)).toBe("stale");
    expect(planState(claims, null, 1_000)).toBe("stale");
    expect(planState(claims, { schemaRevision: 1, dataRevision: 25 }, claims.expiresAtMs)).toBe("expired");
  });
});
