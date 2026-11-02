// The draft of the window "Manage columns" (Scope §5.6, makieta 19; D31.1): the columns as the owner
// edits them, the one change they make, and the request of its preview. One request is one change
// (D26), so the window holds one change at a time: once a field differs from the registry, every other
// field waits until it is saved or cancelled. The rules of a change are the server's; these checks only
// spare a round trip for what is plainly wrong, and the issues of a refusal come back to the field
// that caused them.
import type { RegistryDto, StructureChangeRequest } from "@openlife/contracts/http/registries";
import { parseInput, type FormColumn } from "./record-input.js";
import { emptyColumn, symbolProblem, typeOptionsOf, type ColumnDraft, type FieldPath, type FieldProblem } from "./registry-draft.js";

/** A column of the registry as the window edits it. */
export type ExistingColumn = Readonly<{
  id: string;
  displayName: string;
  required: boolean;
  removed: boolean;
  /** The value typed for the empty cells when the column becomes required. */
  emptiesText: string;
}>;

/** The new column: the row of the kreator with the value its records get. */
export type AddedColumn = ColumnDraft & Readonly<{ defaultText: string }>;

export type StructureDraft = Readonly<{ columns: readonly ExistingColumn[]; added: AddedColumn | null }>;

export const draftOf = (registry: RegistryDto): StructureDraft => ({
  columns: registry.columns.map((column) => ({ id: column.id, displayName: column.displayName, required: column.required, removed: false, emptiesText: "" })),
  added: null,
});

export const newAddedColumn = (): AddedColumn => ({ ...emptyColumn(0), defaultText: "" });

/** The one thing the draft changes: a field of a column, or the new column. */
export type Edit = Readonly<{ kind: "rename" | "required" | "remove"; columnId: string }> | Readonly<{ kind: "add" }>;

/** The control an edit belongs to; every other control waits while it is in the draft. */
export const editKey = (edit: Edit): string => (edit.kind === "add" ? "add" : `${edit.kind}:${edit.columnId}`);

/** Everything the draft changes against the registry, in the order of the columns and the new column last. */
export function editsOf(draft: StructureDraft, registry: RegistryDto): Edit[] {
  const edits: Edit[] = [];
  for (const column of draft.columns) {
    const stored = registry.columns.find((each) => each.id === column.id);
    if (stored === undefined) continue;
    if (column.removed) edits.push({ kind: "remove", columnId: column.id });
    if (column.displayName.trim() !== stored.displayName) edits.push({ kind: "rename", columnId: column.id });
    if (column.required !== stored.required) edits.push({ kind: "required", columnId: column.id });
  }
  if (draft.added !== null) edits.push({ kind: "add" });
  return edits;
}

/** The controls of one column, by the key of the edit each makes. */
export const columnKeys = (columnId: string) => ({ rename: editKey({ kind: "rename", columnId }), required: editKey({ kind: "required", columnId }), remove: editKey({ kind: "remove", columnId }) });

/** True when the control `key` must wait: another edit is in the draft. */
export const waits = (edits: readonly Edit[], key: string): boolean => edits.length > 0 && !edits.some((edit) => editKey(edit) === key);

/** The paths of the fields of the window: a column's by its identifier, the new column's under `added`. */
export const columnField = (columnId: string, field: "displayName" | "required" | "replacement" | "column"): FieldPath => (field === "column" ? `columns.${columnId}` : `columns.${columnId}.${field}`);
/** The paths of the fields of one column, by name. */
export const columnPaths = (columnId: string) => ({ column: columnField(columnId, "column"), displayName: columnField(columnId, "displayName"), replacement: columnField(columnId, "replacement") });
export const ADDED = { column: "added", displayName: "added.displayName", symbol: "added.symbol", type: "added.type", typeOptions: "added.typeOptions", dictionary: "added.typeOptions.dictionaryId", defaultValue: "added.defaultValue", required: "added.required" } as const;

export type DraftProblem = FieldProblem | "DEFAULT_INVALID" | "REPLACEMENT_INVALID";

/** A column of the new type as the value parser reads it. */
const formColumnOf = (added: AddedColumn): FormColumn => ({ symbol: added.symbol, displayName: added.displayName, type: added.type, typeOptions: typeOptionsOf(added), defaultValue: null, required: added.required });

export type ChangeResult = Readonly<{ ok: true; change: StructureChangeRequest }> | Readonly<{ ok: false; problems: ReadonlyMap<FieldPath, DraftProblem> }>;

/**
 * The request for the one edit of the draft, or what is plainly wrong in it. A value for the empty
 * cells or a default is converted as the window of a record converts it; nothing typed is no value.
 */
export function changeOf(edit: Edit, draft: StructureDraft, registry: RegistryDto, timeZone: string): ChangeResult {
  const problems = new Map<FieldPath, DraftProblem>();
  if (edit.kind === "add") {
    const added = draft.added;
    if (added === null) throw new Error("no new column in the draft");
    if (added.displayName.trim() === "") problems.set(ADDED.displayName, "NAME_EMPTY");
    const symbol = symbolProblem(added.symbol, new Set(registry.columns.map((column) => column.symbol)));
    if (symbol !== null) problems.set(ADDED.symbol, symbol);
    const parsed = parseInput(formColumnOf(added), added.defaultText, timeZone);
    if (!parsed.ok) problems.set(ADDED.defaultValue, "DEFAULT_INVALID");
    if (problems.size > 0 || !parsed.ok) return { ok: false, problems };
    return {
      ok: true,
      change: {
        kind: "addColumn",
        column: { symbol: added.symbol, displayName: added.displayName.trim(), type: added.type, typeOptions: typeOptionsOf(added), required: added.required, ...(parsed.value === null ? {} : { defaultValue: parsed.value }) },
      },
    };
  }
  const column = draft.columns.find((each) => each.id === edit.columnId);
  const stored = registry.columns.find((each) => each.id === edit.columnId);
  if (column === undefined || stored === undefined) throw new Error("the edit names no column of the registry");
  switch (edit.kind) {
    case "remove":
      return { ok: true, change: { kind: "removeColumn", columnId: column.id } };
    case "rename": {
      const displayName = column.displayName.trim();
      if (displayName === "") return { ok: false, problems: new Map([[columnField(column.id, "displayName"), "NAME_EMPTY"]]) };
      return { ok: true, change: { kind: "renameColumn", columnId: column.id, displayName } };
    }
    case "required": {
      if (!column.required) return { ok: true, change: { kind: "setRequired", columnId: column.id, required: false } };
      const parsed = parseInput(stored, column.emptiesText, timeZone);
      if (!parsed.ok) return { ok: false, problems: new Map([[columnField(column.id, "replacement"), "REPLACEMENT_INVALID"]]) };
      return { ok: true, change: { kind: "setRequired", columnId: column.id, required: true, ...(parsed.value === null ? {} : { replacement: parsed.value }) } };
    }
  }
}

/** The field of the window an issue of a refused change names (`details.issues[].path`). */
export function fieldOfIssue(change: StructureChangeRequest, path: string): FieldPath {
  if (change.kind === "addColumn") return path === "column" ? ADDED.column : path.startsWith("column.") ? `${ADDED.column}.${path.slice("column.".length)}` : ADDED.column;
  if (change.kind === "deleteRegistry") return "registry";
  if (path === "columnId") return columnField(change.columnId, "column");
  if (path === "displayName" || path === "required" || path === "replacement") return columnField(change.columnId, path);
  return columnField(change.columnId, "column");
}
