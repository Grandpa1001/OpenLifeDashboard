// D23.3 — the change of a record in the form (Scope §5.6, makieta 21), as pure functions: only the
// fields that differ from the base are sent, a stored value shown in its field and sent unchanged is
// the same value, a conflict lists only the fields that differ from the server, and loading the
// newer record keeps what the owner typed while taking the other session's changes.
import { describe, expect, it } from "vitest";
import { changedValues, conflictRows, rebaseTyped, recordName, sameRecord, sameValue } from "../../../apps/web/src/features/registers/lib/record-edit.js";
import { parseInput, valueText, type FormColumn } from "../../../apps/web/src/features/registers/lib/record-input.js";

const ZONE = "Europe/Warsaw";
const column = (symbol: string, type: FormColumn["type"], decimalPlaces?: number): FormColumn => ({ symbol, displayName: symbol, type, typeOptions: decimalPlaces === undefined ? {} : { decimalPlaces }, defaultValue: null, required: false });
const COLUMNS = [column("tytul", "text"), column("ocena", "number", 1), column("cena", "money"), column("rozpoczeto", "datetime"), column("data", "date"), column("o", "time"), column("czy", "boolean"), column("status", "choice")];
const STORED = { tytul: "Projektowanie dla oka", ocena: 4.5, cena: 1037, rozpoczeto: "2026-03-15T08:30:00.000Z", data: "2026-03-15", o: "07:05", czy: false, status: "czytam" };
const textsOf = (values: Record<string, unknown>) => new Map(COLUMNS.map((each) => [each.symbol, valueText(each, (values[each.symbol] ?? null) as never, ZONE)]));

describe("D23.3 what a change sends", () => {
  it("every stored value shown in its field and read back is the same value, so an untouched form sends nothing", () => {
    const typed = textsOf(STORED);
    const values = Object.fromEntries(COLUMNS.map((each) => {
      const parsed = parseInput(each, typed.get(each.symbol)!, ZONE);
      if (!parsed.ok) throw new Error(`${each.symbol} did not read back`);
      return [each.symbol, parsed.value];
    }));
    expect(changedValues(COLUMNS, STORED, values)).toEqual({});
    expect(sameRecord(COLUMNS, STORED, values)).toBe(true);
    // A date-time is the same instant however it is written; anything else is the same value or not.
    expect(sameValue(column("x", "datetime"), "2026-03-15T08:30:00Z", "2026-03-15T08:30:00.000Z")).toBe(true);
    expect(sameValue(column("x", "number"), 0, null)).toBe(false);
  });

  it("only the fields that differ from the base are sent, a cleared field as null", () => {
    expect(changedValues(COLUMNS, STORED, { ...STORED, ocena: 5, status: "przeczytana", cena: null })).toEqual({ ocena: 5, status: "przeczytana", cena: null });
  });
});

describe("D23.3 a conflict with a newer record (makieta 21)", () => {
  const SERVER = { ...STORED, ocena: 4.5, status: "czytam", tytul: "Projektowanie dla oka (wyd. 2)" };

  it("lists only the fields where the server and the form differ, with what was typed even when it is not a value yet", () => {
    const typed = textsOf({ ...STORED, ocena: 5, status: "przeczytana" });
    expect(conflictRows(COLUMNS, SERVER, typed, ZONE).map((row) => [row.column.symbol, row.server, row.mine])).toEqual([
      ["tytul", "Projektowanie dla oka (wyd. 2)", { ok: true, value: "Projektowanie dla oka" }],
      ["ocena", 4.5, { ok: true, value: 5 }],
      ["status", "czytam", { ok: true, value: "przeczytana" }],
    ]);
    const unfinished = new Map(typed).set("cena", "10,375");
    expect(conflictRows(COLUMNS, SERVER, unfinished, ZONE).find((row) => row.column.symbol === "cena")?.mine).toEqual({ ok: false, text: "10,375" });
  });

  it("loading the newer record keeps the fields the owner changed and shows the newer values in the others", () => {
    const typed = textsOf({ ...STORED, ocena: 5, status: "przeczytana" });
    const rebased = rebaseTyped(COLUMNS, STORED, SERVER, typed, ZONE);
    expect(rebased.get("ocena")).toBe("5");
    expect(rebased.get("status")).toBe("przeczytana");
    // The title the other session changed, and the owner did not touch, is the server's now.
    expect(rebased.get("tytul")).toBe("Projektowanie dla oka (wyd. 2)");
    // Saved on the new base, the change sends only the owner's fields: the other session's title stays.
    const values = Object.fromEntries(COLUMNS.map((each) => [each.symbol, (parseInput(each, rebased.get(each.symbol)!, ZONE) as { value: unknown }).value]));
    expect(changedValues(COLUMNS, SERVER, values as never)).toEqual({ ocena: 5, status: "przeczytana" });
    expect(conflictRows(COLUMNS, SERVER, rebased, ZONE).map((row) => row.column.symbol)).toEqual(["ocena", "status"]);
  });
});

describe("D23.3 the name of a record in a label", () => {
  it("is the first text column with a value; a record without one has none", () => {
    expect(recordName(COLUMNS, STORED)).toBe("Projektowanie dla oka");
    expect(recordName([column("autor", "text"), ...COLUMNS], { ...STORED, autor: "  " })).toBe("Projektowanie dla oka");
    expect(recordName([column("kg", "number")], { kg: 71.5 })).toBeNull();
  });
});
