// A change of a column's type carried out on its plan (Architektura §4.5 p. 3–7, §4.6, §5.2; D27.1):
// the work of one unit of the writer. The plan of the preview is checked again on the registry as
// the writer reads it, before any DDL; the values are reported again, so the rebuild can be held to
// the same count of failures; then the table is rebuilt, the catalog changed and the change audited,
// all in this unit, so a failure at any stage leaves the catalog, the table, the bindings and the
// audit as they were. Who may ask for it is decided by the caller: the operation of the gate (D27.2)
// and the route with its session (D29) wrap this work, it reads no session itself.
import type { AppendAudit } from "../../audit/public.js";
import type { Commit } from "../../../foundation/public.js";
import type { OwnerPreferencesStore } from "../../settings/public.js";
import type { RegistryLimits } from "../domain/limits.js";
import { assessChange, conversionOf, reportConversion } from "../domain/structure-change.js";
import { planTypeChange } from "../domain/type-change.js";
import type { DictionaryLookup, PlanSigner, RecordStore, RegistryStore, TableRebuild } from "../ports.js";
import { otherKind, plannedChange, type PlannedChangeInput } from "./planned-change.js";

export type TypeChangePorts = Readonly<{
  registries: RegistryStore;
  records: Pick<RecordStore, "columnValues">;
  dictionaryLookup: Pick<DictionaryLookup, "ids">;
  preferences: Pick<OwnerPreferencesStore, "read">;
  rebuild: TableRebuild;
  audit: AppendAudit;
}>;

export type TypeChangeDependencies = Readonly<{ signer: PlanSigner; limits: RegistryLimits; nowMs: number }>;
export type TypeChangeInput = PlannedChangeInput;
export type TypeChanged = Readonly<{ registryId: string; schemaRevision: number; rows: number; failed: number }>;

/** A zone the owner has not chosen yet is UTC, as in the preview. */
const DEFAULT_TIME_ZONE = "UTC";

export function changeColumnType(ports: TypeChangePorts, deps: TypeChangeDependencies, input: TypeChangeInput): Commit<TypeChanged> {
  const { registry, change } = plannedChange(ports, deps, input);
  if (change.kind !== "changeType") throw otherKind();
  const column = registry.columns.find((each) => each.id === change.columnId);
  if (column === undefined) throw new TypeError("a checked change names a column of the registry");

  const context = { timeZone: ports.preferences.read(registry.ownerId)?.timezone ?? DEFAULT_TIME_ZONE, textMaxCodePoints: deps.limits.textMaxChars };
  // The values are those of the preview (the plan is current), so a blocked change here is a bug, not a state.
  const report = reportConversion(ports.records.columnValues(registry, column.symbol), conversionOf(column, change, context));
  if (assessChange(change, { records: 0, conversion: report }).blocked !== null) throw new TypeError("a plan was issued for a blocked change");

  const plan = planTypeChange(column, change, context);
  const columns = registry.columns.map((each) => (each.id === column.id ? plan.target : each));
  const rebuilt = ports.rebuild.rebuild(registry, columns, { symbol: column.symbol, rewrite: plan.rewrite });
  if (rebuilt.failed !== report.failed) throw new TypeError("the rebuild failed other values than the report counted");

  const nowIso = new Date(deps.nowMs).toISOString();
  ports.registries.changeColumn(registry, plan.target, nowIso);
  ports.audit.append({
    ownerId: registry.ownerId,
    action: "registry.column_type_changed",
    entityId: registry.id,
    at: nowIso,
    requestId: input.requestId,
    details: { registry: registry.symbol, column: column.symbol, fromType: column.type, toType: plan.target.type, rows: rebuilt.rows, failed: rebuilt.failed },
  });
  return { value: { registryId: registry.id, schemaRevision: registry.schemaRevision + 1, rows: rebuilt.rows, failed: rebuilt.failed }, invalidations: [{ resource: "schema", ownerId: registry.ownerId, resourceId: registry.id }] };
}
