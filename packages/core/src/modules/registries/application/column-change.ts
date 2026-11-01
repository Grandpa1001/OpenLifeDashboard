// Adding, renaming and removing a column and changing whether it is required, carried out on the
// plan of the preview (Scope §5.6, S8; Architektura §4.5 p. 3, 6, §5.2; D28.1): the work of one unit
// of the writer, as for a change of type (D27.1). The plan is checked again under the writer before
// any DDL; the column's DDL, the catalog with a raised schema revision and the audit then commit
// together, so a failure at any point leaves the registry as it was. A new required column writes its
// default into every record there is; a column that becomes required fills its empty cells, by the
// rule of a record, with the replacement of the plan, and the count is held to the cells found empty
// under the writer. A removed column keeps its row in the catalog, so its bindings are broken and its
// symbol is free again. Who may ask for it is the caller's (the operation of the gate, the route).
import type { AppendAudit, AuditDetails } from "../../audit/public.js";
import type { Commit } from "../../../foundation/public.js";
import type { RegistryLimits } from "../domain/limits.js";
import { isEmptyCell } from "../domain/record-rules.js";
import { assessChange } from "../domain/structure-change.js";
import type { DictionaryLookup, PlanSigner, RecordStore, RegistryStore, StoredColumn, StoredRegistry, TableColumns } from "../ports.js";
import { otherKind, plannedChange, type PlannedChangeInput } from "./planned-change.js";

export type ColumnChangePorts = Readonly<{
  registries: RegistryStore;
  records: Pick<RecordStore, "count" | "columnValues">;
  dictionaryLookup: Pick<DictionaryLookup, "ids">;
  columns: TableColumns;
  audit: AppendAudit;
}>;

export type ColumnChangeDependencies = Readonly<{ signer: PlanSigner; limits: RegistryLimits; nowMs: number; /** A new identifier (UUIDv7) for an added column. */ newId: () => string }>;
export type ColumnChangeInput = PlannedChangeInput;
export type ColumnChanged = Readonly<{ registryId: string; schemaRevision: number; columnId: string; /** The records whose values the change wrote. */ affected: number }>;

/** The column a checked change names: the rules found it among the active columns of the registry. */
function columnOf(registry: StoredRegistry, columnId: string): StoredColumn {
  const column = registry.columns.find((each) => each.id === columnId);
  if (column === undefined) throw new TypeError("a checked change names a column of the registry");
  return column;
}

export function applyColumnChange(ports: ColumnChangePorts, deps: ColumnChangeDependencies, input: ColumnChangeInput): Commit<ColumnChanged> {
  const { registry, change } = plannedChange(ports, deps, input);
  const nowIso = new Date(deps.nowMs).toISOString();
  let columnId: string;
  let affected = 0;
  let audit: Readonly<{ action: string; details: AuditDetails }>;

  switch (change.kind) {
    case "addColumn": {
      const records = ports.records.count(registry);
      const assessed = assessChange(change, { records });
      // The plan is current, so the records are those of the preview: a blocked change here is a bug, not a state.
      if (assessed.blocked !== null) throw new TypeError("a plan was issued for a blocked change");
      const column = { ...change.column, id: deps.newId() };
      affected = ports.columns.add(registry, column, column.required ? column.defaultValue : null);
      if (affected !== assessed.affected) throw new TypeError("the default was written into other records than the registry has");
      ports.registries.addColumn(registry, column, nowIso);
      columnId = column.id;
      audit = { action: "registry.column_added", details: { registry: registry.symbol, column: column.symbol, type: column.type, required: column.required, filled: affected } };
      break;
    }
    case "renameColumn": {
      const column = columnOf(registry, change.columnId);
      ports.registries.renameColumn(registry, column.id, change.displayName, nowIso);
      columnId = column.id;
      audit = { action: "registry.column_renamed", details: { registry: registry.symbol, column: column.symbol } };
      break;
    }
    case "removeColumn": {
      const column = columnOf(registry, change.columnId);
      ports.columns.remove(registry, column);
      ports.registries.removeColumn(registry, column.id, nowIso);
      columnId = column.id;
      audit = { action: "registry.column_removed", details: { registry: registry.symbol, column: column.symbol } };
      break;
    }
    case "setRequired": {
      const column = columnOf(registry, change.columnId);
      if (change.required) {
        let empty = 0;
        for (const value of ports.records.columnValues(registry, column.symbol)) if (isEmptyCell(column.type, value)) empty += 1;
        if (empty > 0 && change.replacement === null) throw new TypeError("a plan was issued for a blocked change");
        affected = empty === 0 ? 0 : ports.columns.fillEmpty(registry, column, change.replacement, (value) => isEmptyCell(column.type, value));
        if (affected !== empty) throw new TypeError("the replacement was written into other cells than were empty");
      }
      ports.registries.changeColumn(registry, { ...column, required: change.required }, nowIso);
      columnId = column.id;
      audit = { action: "registry.column_required_changed", details: { registry: registry.symbol, column: column.symbol, required: change.required, filled: affected } };
      break;
    }
    default:
      throw otherKind();
  }

  ports.audit.append({ ownerId: registry.ownerId, action: audit.action, entityId: registry.id, at: nowIso, requestId: input.requestId, details: audit.details });
  return {
    value: { registryId: registry.id, schemaRevision: registry.schemaRevision + 1, columnId, affected },
    invalidations: [{ resource: "schema", ownerId: registry.ownerId, resourceId: registry.id }],
  };
}
