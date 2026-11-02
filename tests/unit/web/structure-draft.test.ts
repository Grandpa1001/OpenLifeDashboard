// D31.1, D31.2 — the draft of the window "Manage columns" (Scope §5.6, makieta 19, 20) as pure functions: one
// change at a time, its request as core reads it, the values for empty cells and the default
// converted as the window of a record converts them, and the issues of a refusal at their field.
import { describe, expect, it } from "vitest";
import type { RegistryDto } from "@openlife/contracts/http/registries";
import { DEFAULT_REGISTRY_LIMITS, validateStructureChange, type StructureSchema } from "../../../packages/core/dist/modules/registries/public.js";
import { ADDED, changeOf, columnKeys, columnPaths, draftOf, editsOf, fieldOfIssue, newAddedColumn, waits, withExit, type StructureDraft } from "../../../apps/web/src/features/registers/lib/structure-draft.js";

const TZ = "Europe/Warsaw";
const column = (id: string, symbol: string, displayName: string, type: RegistryDto["columns"][number]["type"], position: number, extra: Partial<RegistryDto["columns"][number]> = {}) => ({ id, symbol, displayName, type, typeOptions: {}, defaultValue: null, required: false, position, ...extra });
const BOOKS: RegistryDto = {
  id: "019a0000-0000-7000-8000-000000000b00",
  symbol: "ksiazki",
  displayName: "Książki",
  schemaRevision: 1,
  dataRevision: 25,
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
  columns: [
    column("019a0000-0000-7000-8000-000000000b01", "tytul", "Tytuł", "text", 0, { required: true }),
    column("019a0000-0000-7000-8000-000000000b02", "autor", "Autor", "text", 1),
    column("019a0000-0000-7000-8000-000000000b03", "strony", "Liczba stron", "number", 2, { typeOptions: { decimalPlaces: 0 } }),
    column("019a0000-0000-7000-8000-000000000b04", "data_ukonczenia", "Data ukończenia", "date", 3),
  ],
};
const [TYTUL, AUTOR, STRONY, DATA] = BOOKS.columns.map((each) => each.id) as [string, string, string, string];
const SCHEMA: StructureSchema = { registryId: BOOKS.id, columns: BOOKS.columns.map(({ id, symbol, displayName, type, typeOptions, required, defaultValue }) => ({ id, symbol, displayName, type, typeOptions: typeOptions.decimalPlaces === undefined ? {} : { decimalPlaces: typeOptions.decimalPlaces }, required, defaultValue })) };
const accepted = (change: unknown) => validateStructureChange(change, SCHEMA, { limits: DEFAULT_REGISTRY_LIMITS, dictionaryIds: new Set() }).ok;

const edit = (draft: StructureDraft, columnId: string, change: Partial<StructureDraft["columns"][number]>): StructureDraft => ({ ...draft, columns: draft.columns.map((each) => (each.id === columnId ? { ...each, ...change } : each)) });

describe("D31.1 the draft of the structure", () => {
  it("is no change untouched; one edit makes every other control wait; its request is one core accepts", () => {
    const draft = draftOf(BOOKS);
    expect(editsOf(draft, BOOKS)).toEqual([]);
    expect(waits([], columnKeys(AUTOR).remove)).toBe(false);

    const renamed = edit(draft, STRONY, { displayName: "  Strony " });
    const edits = editsOf(renamed, BOOKS);
    expect(edits).toEqual([{ kind: "rename", columnId: STRONY }]);
    expect(waits(edits, columnKeys(STRONY).rename)).toBe(false);
    expect([waits(edits, columnKeys(STRONY).required), waits(edits, columnKeys(AUTOR).remove), waits(edits, "add")]).toEqual([true, true, true]);
    const change = changeOf(edits[0]!, renamed, BOOKS, TZ);
    expect(change).toEqual({ ok: true, change: { kind: "renameColumn", columnId: STRONY, displayName: "Strony" } });
    expect(change.ok && accepted(change.change)).toBe(true);
    // Typed back to the stored name, it is no change again.
    expect(editsOf(edit(draft, STRONY, { displayName: "Liczba stron" }), BOOKS)).toEqual([]);

    const removed = edit(draft, AUTOR, { removed: true });
    expect(changeOf(editsOf(removed, BOOKS)[0]!, removed, BOOKS, TZ)).toEqual({ ok: true, change: { kind: "removeColumn", columnId: AUTOR } });

    const optional = edit(draft, TYTUL, { required: false });
    expect(changeOf(editsOf(optional, BOOKS)[0]!, optional, BOOKS, TZ)).toEqual({ ok: true, change: { kind: "setRequired", columnId: TYTUL, required: false } });
  });

  it("converts the value for empty cells and the default as the window of a record does, and tells what is plainly wrong", () => {
    const draft = draftOf(BOOKS);
    const required = (text: string) => {
      const next = edit(draft, DATA, { required: true, emptiesText: text });
      return changeOf(editsOf(next, BOOKS)[0]!, next, BOOKS, TZ);
    };
    expect(required("")).toEqual({ ok: true, change: { kind: "setRequired", columnId: DATA, required: true } });
    expect(required("2026-01-31")).toEqual({ ok: true, change: { kind: "setRequired", columnId: DATA, required: true, replacement: "2026-01-31" } });
    expect(required("2026-02-31")).toEqual({ ok: false, problems: new Map([[columnPaths(DATA).replacement, "REPLACEMENT_INVALID"]]) });

    const added = (change: Partial<ReturnType<typeof newAddedColumn>>) => {
      const next: StructureDraft = { ...draft, added: { ...newAddedColumn(), displayName: "Ocena", symbol: "ocena", ...change } };
      return changeOf({ kind: "add" }, next, BOOKS, TZ);
    };
    const ocena = added({ type: "number", decimalPlaces: 1, required: true, defaultText: "4,5" });
    expect(ocena).toEqual({ ok: true, change: { kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "number", typeOptions: { decimalPlaces: 1 }, required: true, defaultValue: 4.5 } } });
    expect(ocena.ok && accepted(ocena.change)).toBe(true);
    expect(added({ type: "money", defaultText: "10,37" })).toMatchObject({ ok: true, change: { column: { defaultValue: 1037 } } });
    expect(added({ type: "text", defaultText: "" })).toEqual({ ok: true, change: { kind: "addColumn", column: { symbol: "ocena", displayName: "Ocena", type: "text", typeOptions: {}, required: false } } });
    expect(added({ type: "number", defaultText: "4,55" })).toEqual({ ok: false, problems: new Map([[ADDED.defaultValue, "DEFAULT_INVALID"]]) });
    expect(added({ symbol: "autor", displayName: " " })).toEqual({ ok: false, problems: new Map([[ADDED.displayName, "NAME_EMPTY"], [ADDED.symbol, "SYMBOL_TAKEN"]]) });
    expect(added({ symbol: "Ocena!" })).toEqual({ ok: false, problems: new Map([[ADDED.symbol, "SYMBOL_PATTERN"]]) });

    const unnamed = edit(draft, AUTOR, { displayName: "  " });
    expect(changeOf(editsOf(unnamed, BOOKS)[0]!, unnamed, BOOKS, TZ)).toEqual({ ok: false, problems: new Map([[columnPaths(AUTOR).displayName, "NAME_EMPTY"]]) });
  });

  it("puts each issue of a refusal at the field of the change that caused it", () => {
    const add = { kind: "addColumn", column: { symbol: "id", displayName: "Id", type: "text" } } as const;
    expect([fieldOfIssue(add, "column.symbol"), fieldOfIssue(add, "column.defaultValue"), fieldOfIssue(add, "column")]).toEqual([ADDED.symbol, ADDED.defaultValue, ADDED.column]);
    const required = { kind: "setRequired", columnId: DATA, required: true, replacement: "x" } as const;
    expect([fieldOfIssue(required, "replacement"), fieldOfIssue(required, "columnId"), fieldOfIssue(required, "kind")]).toEqual([columnPaths(DATA).replacement, columnPaths(DATA).column, columnPaths(DATA).column]);
    expect(fieldOfIssue({ kind: "renameColumn", columnId: AUTOR, displayName: "" }, "displayName")).toBe(columnPaths(AUTOR).displayName);
    expect(fieldOfIssue({ kind: "deleteRegistry" }, "kind")).toBe("registry");
  });
});

describe("D31.2 a change of type in the draft", () => {
  it("is one edit of the column with its options; back to the stored type and options it is no change; core accepts it", () => {
    const draft = draftOf(BOOKS);
    const toText = edit(draft, STRONY, { type: "text", decimalPlaces: 0 });
    const edits = editsOf(toText, BOOKS);
    expect(edits).toEqual([{ kind: "type", columnId: STRONY }]);
    expect([waits(edits, columnKeys(STRONY).type), waits(edits, columnKeys(STRONY).rename)]).toEqual([false, true]);
    const change = changeOf(edits[0]!, toText, BOOKS, TZ);
    expect(change).toEqual({ ok: true, change: { kind: "changeType", columnId: STRONY, type: "text", typeOptions: {} } });
    expect(change.ok && accepted(change.change)).toBe(true);
    // Other places are a change of the same type; the stored places are none.
    expect(editsOf(edit(draft, STRONY, { decimalPlaces: 2 }), BOOKS)).toEqual([{ kind: "type", columnId: STRONY }]);
    expect(editsOf(edit(draft, STRONY, { type: "number", decimalPlaces: 0 }), BOOKS)).toEqual([]);
  });

  it("takes one way out at a time: a replacement of the new type typed as in a record, or the column made optional", () => {
    const change = { kind: "changeType", columnId: AUTOR, type: "number", typeOptions: { decimalPlaces: 1 } } as const;
    expect(withExit(change, { kind: "replacement", text: "0,5" }, TZ)).toEqual({ ok: true, change: { ...change, replacement: 0.5 } });
    expect(withExit(change, { kind: "replacement", text: "abc" }, TZ)).toEqual({ ok: false, problem: "REPLACEMENT_INVALID" });
    expect(withExit(change, { kind: "replacement", text: "" }, TZ)).toEqual({ ok: false, problem: "REPLACEMENT_INVALID" });
    expect(withExit(change, { kind: "replacement", text: "0,55" }, TZ)).toEqual({ ok: false, problem: "REPLACEMENT_INVALID" });
    const replaced = withExit(change, { kind: "replacement", text: "1" }, TZ);
    expect(replaced.ok && replaced.change.kind === "changeType" && withExit(replaced.change, { kind: "optional" }, TZ)).toEqual({ ok: true, change: { ...change, required: false } });
    expect(fieldOfIssue(change, "type")).toBe(columnPaths(AUTOR).type);
    expect(fieldOfIssue(change, "typeOptions.dictionaryId")).toBe(columnPaths(AUTOR).type);
  });
});
