// D34.2 — the order of the columns of the register table (Scope §5.4, §6.2): the bindings follow the
// order the owner chose, Alt + arrow and a drop move one chosen column, All chooses every column and
// then leaves one, and "Remove the binding" keeps what is still there.
import type { RegistryDto } from "@openlife/contracts/http/registries";
import { describe, expect, it } from "vitest";
import { bindingsOf, droppedColumn, movedColumn, orderedOffer, pickableColumns, toggledAll, withoutMissing } from "../../../apps/web/src/features/dashboard/lib/register-table-bindings.js";

const column = (id: string, symbol: string, position: number) => ({ id, symbol, displayName: symbol, type: "text" as const, typeOptions: {}, defaultValue: null, required: false, position });
const registry = { id: "01900000-0000-7000-8000-0000000034f2", symbol: "k", displayName: "K", schemaRevision: 1, dataRevision: 0, createdAt: "", updatedAt: "", columns: [column("c-a", "a", 0), column("c-b", "b", 1), column("c-c", "c", 2)] } as RegistryDto;
const offer = pickableColumns(registry);

describe("D34.2 the order of the columns", () => {
  it("the bindings of the columns follow the order of the choice, with ordinals from 0", () => {
    expect(bindingsOf(registry, ["c-c", "c-a"], null).filter((binding) => binding.slot === "columns").map((binding) => `${binding.ordinal}:${binding.path}`)).toEqual(["0:Field.Register.k.c", "1:Field.Register.k.a"]);
  });

  it("the list shows the chosen columns in their order, then the others in the order of the registry", () => {
    expect(orderedOffer(offer, ["c-c", "c-a"]).map((pick) => pick.key)).toEqual(["c-c", "c-a", "c-b", "created_at", "updated_at"]);
  });

  it("Alt + arrow moves one chosen column by one place and stops at the ends; a column not chosen does not move", () => {
    expect(movedColumn(["c-a", "c-b", "c-c"], "c-a", 1)).toEqual(["c-b", "c-a", "c-c"]);
    expect(movedColumn(["c-a", "c-b", "c-c"], "c-c", -1)).toEqual(["c-a", "c-c", "c-b"]);
    const ends = ["c-a", "c-b"];
    expect(movedColumn(ends, "c-a", -1)).toBe(ends);
    expect(movedColumn(ends, "c-b", 1)).toBe(ends);
    expect(movedColumn(ends, "c-c", 1)).toBe(ends);
  });

  it("a drop puts the column where the other one is, up or down", () => {
    expect(droppedColumn(["c-a", "c-b", "c-c"], "c-c", "c-a")).toEqual(["c-c", "c-a", "c-b"]);
    expect(droppedColumn(["c-a", "c-b", "c-c"], "c-a", "c-c")).toEqual(["c-b", "c-c", "c-a"]);
    expect(droppedColumn(["c-a", "c-b"], "c-a", "created_at")).toEqual(["c-a", "c-b"]);
  });

  it("All chooses every column in the order of the list, and then leaves only the first", () => {
    const all = toggledAll(offer, ["c-b"]);
    expect(all).toEqual(["c-b", "c-a", "c-c", "created_at", "updated_at"]);
    expect(toggledAll(offer, all)).toEqual(["c-b"]);
  });

  it("Remove the binding keeps the columns still there with ordinals from 0, and a gone registry leaves the table unbound", () => {
    const bindings = bindingsOf(registry, ["c-a", "c-b", "c-c"], null);
    expect(withoutMissing(bindings, ["Field.Register.k.b"], false).map((binding) => `${binding.slot}.${binding.ordinal}:${binding.path}`)).toEqual(["registry.0:Field.Register.k", "columns.0:Field.Register.k.a", "columns.1:Field.Register.k.c"]);
    expect(withoutMissing(bindings, ["Field.Register.k"], true)).toEqual([]);
  });
});
