// D16.3 — what the owner types becomes the canonical value of the API, and a stored value is read
// back in the owner's language and zone. The conversion of an amount and of a wall-clock time is
// made once, in the form (D15 takes the canonical form only).
import { describe, expect, it } from "vitest";
import { isValidCellValue } from "../../../packages/core/dist/modules/registries/public.js";
import { formatCell } from "../../../apps/web/src/lib/format/cell-format.js";
import { centsToText, initialText, parseInput, type FormColumn } from "../../../apps/web/src/features/registers/lib/record-input.js";
import { utcIsoToZonedLocal, zonedLocalToUtcIso } from "../../../apps/web/src/features/registers/lib/zoned-time.js";

const column = (type: FormColumn["type"], extra: Partial<FormColumn> = {}): FormColumn => ({ symbol: "c", displayName: "C", type, typeOptions: {}, defaultValue: null, required: false, ...extra });
const WARSAW = "Europe/Warsaw";

describe("D16.3 the wall of a zone and the instant it stands for", () => {
  it("winter and summer time of Warsaw, UTC, and a zone west of Greenwich", () => {
    expect(zonedLocalToUtcIso("2026-01-15T12:00", WARSAW)).toBe("2026-01-15T11:00:00.000Z");
    expect(zonedLocalToUtcIso("2026-07-15T12:00", WARSAW)).toBe("2026-07-15T10:00:00.000Z");
    expect(zonedLocalToUtcIso("2026-07-15T12:00", "UTC")).toBe("2026-07-15T12:00:00.000Z");
    expect(zonedLocalToUtcIso("2026-01-15T12:00", "America/New_York")).toBe("2026-01-15T17:00:00.000Z");
    expect(zonedLocalToUtcIso("2026-07-15T12:00", "Asia/Kolkata")).toBe("2026-07-15T06:30:00.000Z");
  });

  it("the days a clock changes: the repeated hour takes its first occurrence, the skipped hour the instant after the change", () => {
    // Warsaw 2026-10-25 02:30 happens twice (CEST then CET); 2026-03-29 02:30 does not happen.
    expect(zonedLocalToUtcIso("2026-10-25T02:30", WARSAW)).toBe("2026-10-25T00:30:00.000Z");
    expect(zonedLocalToUtcIso("2026-03-29T02:30", WARSAW)).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedLocalToUtcIso("2026-03-29T01:59", WARSAW)).toBe("2026-03-29T00:59:00.000Z");
    expect(zonedLocalToUtcIso("2026-03-29T03:00", WARSAW)).toBe("2026-03-29T01:00:00.000Z");
  });

  it("a moment that is not on a calendar is refused, and the way back gives the same wall", () => {
    for (const bad of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-01-01T24:00", "2026-01-01 10:00", "2026-01-01T10:00:00", ""]) expect(zonedLocalToUtcIso(bad, WARSAW), bad).toBeNull();
    for (const local of ["2026-01-15T12:00", "2026-07-15T23:59", "2026-12-31T00:00", "2024-02-29T08:15"]) {
      const iso = zonedLocalToUtcIso(local, WARSAW);
      expect(utcIsoToZonedLocal(iso ?? "", WARSAW)).toBe(local);
    }
    expect(utcIsoToZonedLocal("nope", WARSAW)).toBeNull();
  });
});

describe("D16.3 what is typed becomes the canonical value", () => {
  const parse = (type: FormColumn["type"], typed: string, extra: Partial<FormColumn> = {}) => parseInput(column(type, extra), typed, WARSAW);

  it("an amount: units to grosze, with a comma or a point, a sign, spaces; more than two places is refused", () => {
    for (const [typed, cents] of [["10,37", 1037], ["10.37", 1037], ["10", 1000], ["0,5", 50], ["0.05", 5], ["-3,20", -320], ["+7", 700], ["1 234,50", 123450], ["  12  ", 1200]] as const) {
      expect(parse("money", typed), typed).toEqual({ ok: true, value: cents });
    }
    for (const bad of ["10,375", "abc", "1,2,3", "10 zł", "1e3", ",5", "--1", "99999999999999999"]) expect(parse("money", bad), bad).toEqual({ ok: false });
  });

  it("a number: comma or point, no exponent, no text", () => {
    expect(parse("number", "12,5", { typeOptions: { decimalPlaces: 1 } })).toEqual({ ok: true, value: 12.5 });
    expect(parse("number", "-3")).toEqual({ ok: true, value: -3 });
    expect(parse("number", "1 000")).toEqual({ ok: true, value: 1000 });
    for (const bad of ["abc", "1e3", "0x10", "1.2.3", "Infinity", "NaN", "1,"]) expect(parse("number", bad), bad).toEqual({ ok: false });
  });

  it("nothing typed is null, a text is kept as typed, a boolean is one of two words, a date-time is on the owner's wall", () => {
    for (const type of ["number", "money", "date", "datetime", "time", "boolean"] as const) expect(parse(type, "  ")).toEqual({ ok: true, value: null });
    expect(parse("text", "")).toEqual({ ok: true, value: null });
    expect(parse("text", "  Dune  ")).toEqual({ ok: true, value: "  Dune  " });
    expect(parse("text", "   ")).toEqual({ ok: true, value: "   " });
    expect(parse("choice", "planowane")).toEqual({ ok: true, value: "planowane" });
    expect(parse("boolean", "true")).toEqual({ ok: true, value: true });
    expect(parse("boolean", "false")).toEqual({ ok: true, value: false });
    expect(parse("boolean", "tak")).toEqual({ ok: false });
    expect(parse("date", "2026-02-03")).toEqual({ ok: true, value: "2026-02-03" });
    expect(parse("time", "18:30")).toEqual({ ok: true, value: "18:30" });
    expect(parse("datetime", "2026-07-15T12:00")).toEqual({ ok: true, value: "2026-07-15T10:00:00.000Z" });
    expect(parse("datetime", "garbage")).toEqual({ ok: false });
  });

  it("the default of a column is shown as it is typed: a boolean as its word, an amount in units, a date-time on the owner's wall", () => {
    expect(initialText(column("boolean", { defaultValue: false }), WARSAW)).toBe("false");
    expect(initialText(column("boolean", { defaultValue: true }), WARSAW)).toBe("true");
    expect(initialText(column("money", { defaultValue: 1037 }), WARSAW)).toBe("10.37");
    expect(initialText(column("money", { defaultValue: -5 }), WARSAW)).toBe("-0.05");
    expect(initialText(column("datetime", { defaultValue: "2026-07-15T10:00:00.000Z" }), WARSAW)).toBe("2026-07-15T12:00");
    expect(initialText(column("number", { defaultValue: 2.5 }), WARSAW)).toBe("2.5");
    expect(initialText(column("choice", { defaultValue: "planowane" }), WARSAW)).toBe("planowane");
    expect(initialText(column("text"), WARSAW)).toBe("");
  });

  it("an amount survives the round trip through the form", () => {
    for (const cents of [0, 1, 99, 100, 1037, -1037, 123456789]) {
      const text = initialText(column("money", { defaultValue: cents }), WARSAW);
      expect(parse("money", text)).toEqual({ ok: true, value: cents });
    }
  });
});

describe("D16.3 a stored value as it is read", () => {
  const display = { locale: "en", timeZone: WARSAW, dateFormat: "DD.MM.YYYY" } as const;
  it("numbers with the decimals of the column, amounts with two, dates and date-times in the owner's zone", () => {
    expect(formatCell(column("number", { typeOptions: { decimalPlaces: 1 } }), 1234.5, display)).toBe("1,234.5");
    expect(formatCell(column("number"), 7, display)).toBe("7");
    expect(formatCell(column("money"), 1037, display)).toBe("10.37");
    expect(formatCell(column("money"), 1234567, { ...display, locale: "pl" })).toMatch(/^12\s345,67$/);
    expect(formatCell(column("date"), "2026-02-03", display)).toBe("03.02.2026");
    expect(formatCell(column("date"), "2026-02-03", { ...display, dateFormat: "YYYY-MM-DD" })).toBe("2026-02-03");
    expect(formatCell(column("date"), "2026-02-03", { ...display, dateFormat: "MM/DD/YYYY" })).toBe("02/03/2026");
    expect(formatCell(column("date"), "not a date", display)).toBe("not a date");
    expect(formatCell(column("datetime"), "2026-07-15T10:00:00.000Z", display)).toMatch(/^15\.07\.2026, 12:00/);
    expect(formatCell(column("datetime"), "2026-07-15T23:30:00.000Z", display)).toMatch(/^16\.07\.2026, 1:30/);
    expect(formatCell(column("time"), "18:30", display)).toBe("18:30");
    expect(formatCell(column("text"), "<b>x</b>", display)).toBe("<b>x</b>");
    expect(formatCell(column("text"), null, display)).toBe("");
  });
});

// D22.1 — the web app has its own conversion (it may not import core); this table ties it to the
// rule of core, which decides what the server stores.
const SAFE = Number.MAX_SAFE_INTEGER;
const TEXT_MAX = 10_000;
const TYPED: Readonly<Record<FormColumn["type"], readonly string[]>> = {
  text: ["", "Dune", "  spacje  ", "<b>x</b>"],
  choice: ["", "planowane", "pl"],
  number: ["", "0", "-3", "12,5", "12.50", "1 000", "0,123456", "0,1234567", "1e3", "Infinity", "abc", "1,"],
  money: ["", "0", "10,37", "-0,05", "1 234,50", "90071992547409,91", "-90071992547409,91", "90071992547409,92", "10,375", "1e3", ",5"],
  date: ["", "2026-02-03", "2024-02-29", "2026-02-29", "2026-02-31", "2026-13-01", "2026-2-3", "03.02.2026"],
  time: ["", "00:00", "18:30", "23:59", "24:00", "7:05", "18:60", "18:30:00"],
  datetime: ["", "2026-07-15T12:00", "2026-03-29T02:30", "2026-10-25T02:30", "2026-02-30T10:00", "2026-07-15 12:00", "garbage"],
  boolean: ["", "true", "false", "tak", "1"],
};

describe("D22.1-AC1 every value the form accepts is a value core accepts, and an amount is exact on its whole range", () => {
  for (const [type, inputs] of Object.entries(TYPED) as [FormColumn["type"], readonly string[]][]) {
    for (const places of type === "number" ? [0, 2, 6] : [0]) {
      it(`${type}${type === "number" ? ` with ${places} places` : ""}: accepted input passes core's rule`, () => {
        const options = type === "number" ? { decimalPlaces: places } : {};
        for (const typed of inputs) {
          const parsed = parseInput(column(type, { typeOptions: options }), typed, WARSAW);
          if (parsed.ok) expect(isValidCellValue(type, options, parsed.value, TEXT_MAX), `${type} ${JSON.stringify(typed)} → ${JSON.stringify(parsed.value)}`).toBe(true);
        }
      });
    }
  }

  it("1037 is 10,37 both ways, and the safe-integer bounds survive the round trip without a lost grosz", () => {
    expect(parseInput(column("money"), "10,37", WARSAW)).toEqual({ ok: true, value: 1037 });
    expect(formatCell(column("money"), 1037, { locale: "pl", timeZone: WARSAW, dateFormat: "DD.MM.YYYY" })).toBe("10,37");
    for (const cents of [SAFE, -SAFE, SAFE - 1, 9_007_199_254_740_900, 1, -1, 0]) {
      expect(parseInput(column("money"), centsToText(cents), WARSAW), String(cents)).toEqual({ ok: true, value: cents });
    }
    expect(centsToText(SAFE)).toBe("90071992547409.91");
    expect(formatCell(column("money"), SAFE, { locale: "en", timeZone: WARSAW, dateFormat: "DD.MM.YYYY" })).toBe("90,071,992,547,409.91");
    expect(formatCell(column("money"), -SAFE, { locale: "pl", timeZone: WARSAW, dateFormat: "DD.MM.YYYY" })).toMatch(/^-90\s071\s992\s547\s409,91$/);
    expect(formatCell(column("money"), -5, { locale: "pl", timeZone: WARSAW, dateFormat: "DD.MM.YYYY" })).toBe("-0,05");
  });

  it("a number keeps the decimal places of its column, from 0 to 6, on the edge", () => {
    expect(parseInput(column("number", { typeOptions: { decimalPlaces: 0 } }), "12", WARSAW)).toEqual({ ok: true, value: 12 });
    expect(parseInput(column("number", { typeOptions: { decimalPlaces: 2 } }), "12,50", WARSAW)).toEqual({ ok: true, value: 12.5 });
    expect(parseInput(column("number", { typeOptions: { decimalPlaces: 6 } }), "0,123456", WARSAW)).toEqual({ ok: true, value: 0.123456 });
  });
});

describe("D22.1-AC2 what is no value of its type is refused before anything is sent", () => {
  const refused = (type: FormColumn["type"], typed: string, options: FormColumn["typeOptions"] = {}) => expect(parseInput(column(type, { typeOptions: options }), typed, WARSAW), `${type} ${typed}`).toEqual({ ok: false });

  it("a number with more places than its column, an exponent or a text", () => {
    refused("number", "12,5", { decimalPlaces: 0 });
    refused("number", "0,1234567", { decimalPlaces: 6 });
    refused("number", "1,005", { decimalPlaces: 2 });
    for (const bad of ["1e3", "Infinity", "abc"]) refused("number", bad, { decimalPlaces: 6 });
  });

  it("an amount with three places or one grosz beyond the safe range", () => {
    for (const bad of ["10,375", "90071992547409,92", "-90071992547409,92", "1e3"]) refused("money", bad);
  });

  it("a date off the calendar, an hour that does not exist, a date-time that is no wall time", () => {
    for (const bad of ["2026-02-29", "2026-02-31", "2026-13-01", "2026-2-3", "03.02.2026"]) refused("date", bad);
    for (const bad of ["24:00", "7:05", "18:60", "18:30:00"]) refused("time", bad);
    for (const bad of ["2026-02-30T10:00", "2026-07-15 12:00", "garbage"]) refused("datetime", bad);
  });
});
