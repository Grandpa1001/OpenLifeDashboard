// The deletion of a registry carried out on the plan of its preview (Scope §5.6, S10; Architektura
// §4.5, §4.6, §5.2; D30.1): the work of one unit of the writer. The plan is checked again under the
// writer before any DDL; the table is dropped, the catalog marks the registry deleted with a raised
// schema revision and the deletion is audited, all in this unit, so a failure leaves the registry as it
// was. The rows of the registry and its columns stay: its symbol stays taken, a binding to it is broken
// (`needs_rebinding` when a screen is read) and the copy pre_delete taken before the unit can restore it
// under the same identifiers (D30.2). Who may ask for it is the caller's: the operation of the gate
// with its copy, and a session through carryOutRegistryDeletion.
import type { AppendAudit } from "../../audit/public.js";
import { DomainFault, type Commit } from "../../../foundation/public.js";
import type { RegistryLimits } from "../domain/limits.js";
import { assessChange } from "../domain/structure-change.js";
import type { DictionaryLookup, PlanSigner, RecordStore, RegistryStore, RegistryTables } from "../ports.js";
import { otherKind, plannedChange, writerOf, type PlannedChangeInput, type WriterAccessPorts } from "./planned-change.js";

export type RegistryDeletionPorts = Readonly<{
  registries: RegistryStore;
  records: Pick<RecordStore, "count">;
  dictionaryLookup: Pick<DictionaryLookup, "ids">;
  tables: RegistryTables;
  audit: AppendAudit;
}>;

export type RegistryDeletionDependencies = Readonly<{ signer: PlanSigner; limits: RegistryLimits; nowMs: number }>;
export type RegistryDeletionInput = PlannedChangeInput;
/** The schema revision the deleted registry was left at, and its records, which the deletion took from view. */
export type RegistryDeleted = Readonly<{ registryId: string; schemaRevision: number; affected: number }>;

export function deleteRegistry(ports: RegistryDeletionPorts, deps: RegistryDeletionDependencies, input: RegistryDeletionInput): Commit<RegistryDeleted> {
  const { registry, change } = plannedChange(ports, deps, input);
  if (change.kind !== "deleteRegistry") throw otherKind();
  // The plan is current, so the records are those the preview counted.
  const records = ports.records.count(registry);
  const { affected } = assessChange(change, { records });
  const nowIso = new Date(deps.nowMs).toISOString();
  ports.tables.drop(registry);
  ports.registries.markDeleted(registry, nowIso);
  ports.audit.append({
    ownerId: registry.ownerId,
    action: "registry.deleted",
    entityId: registry.id,
    at: nowIso,
    requestId: input.requestId,
    details: { registry: registry.symbol, records, columns: registry.columns.length },
  });
  return { value: { registryId: registry.id, schemaRevision: registry.schemaRevision + 1, affected }, invalidations: [{ resource: "schema", ownerId: registry.ownerId, resourceId: registry.id }] };
}

/**
 * A deletion asked for by a session (D30.1): the session is read again in the unit, after the copy, and
 * must be the owner the operation was begun for, so a session ended meanwhile deletes nothing.
 */
export function carryOutRegistryDeletion(ports: RegistryDeletionPorts & WriterAccessPorts, deps: RegistryDeletionDependencies, token: string, input: RegistryDeletionInput): Commit<RegistryDeleted> {
  if (writerOf(ports, token, deps.nowMs, input.requestId) !== input.ownerId) throw new DomainFault({ code: "AUTH_REQUIRED" });
  return deleteRegistry(ports, deps, input);
}
