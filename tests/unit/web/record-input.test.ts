// D16.3 — what the owner types becomes the canonical value of the API, and a stored value is read
// back in the owner's language and zone. The conversion of an amount and of a wall-clock time is
// made once, in the form (D15 takes the canonical form only).
import { describe, expect, it } from "vitest";
import { formatCell } from "../../../apps/web/src/features/registers/lib/record-format.js";
import { initialText, parseInput, type FormColumn } from "../../../apps/web/src/features/registers/lib/record-input.js";
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
    expect(parse("number", "12,5")).toEqual({ ok: true, value: 12.5 });
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
  const display = { locale: "en", timeZone: WARSAW };
  it("numbers with the decimals of the column, amounts with two, dates and date-times in the owner's zone", () => {
    expect(formatCell(column("number", { typeOptions: { decimalPlaces: 1 } }), 1234.5, display)).toBe("1,234.5");
    expect(formatCell(column("number"), 7, display)).toBe("7");
    expect(formatCell(column("money"), 1037, display)).toBe("10.37");
    expect(formatCell(column("money"), 1234567, { ...display, locale: "pl" })).toMatch(/^12\s345,67$/);
    expect(formatCell(column("date"), "2026-02-03", display)).toBe("Feb 3, 2026");
    expect(formatCell(column("datetime"), "2026-07-15T10:00:00.000Z", display)).toMatch(/^Jul 15, 2026,? 12:00/);
    expect(formatCell(column("datetime"), "2026-07-15T23:30:00.000Z", display)).toMatch(/^Jul 16, 2026,? 1:30/);
    expect(formatCell(column("time"), "18:30", display)).toBe("18:30");
    expect(formatCell(column("text"), "<b>x</b>", display)).toBe("<b>x</b>");
    expect(formatCell(column("text"), null, display)).toBe("");
  });
});
