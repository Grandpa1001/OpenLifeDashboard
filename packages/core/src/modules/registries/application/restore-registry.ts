// The restore of one deleted registry from its copy pre_delete (Scope §5.6, S10; Architektura §5.2,
// §11.3.3; D30.2): the work of one unit of the writer, run by the administrative command under the
// writer lease. The registry in the database must be the very registry of the copy, deleted and
// untouched since: the same identifier, owner, symbol and columns, one schema revision above the copy
// (the deletion's). Anything else is RESTORE_CONFLICT and nothing is written, so a restore never
// overwrites data that exists. The table and its indexes are made again from the definition, the rows
// go back under their identifiers with their times and revisions, the catalog takes the deletion back
// and the restore is audited without values; bindings to the registry are ok again when read.
import type { AppendAudit } from "../../audit/public.js";
import { DomainFault, type Commit } from "../../../foundation/public.js";
import type { RegistryStore, RegistryTables, StoredRegistry, StoredRow } from "../ports.js";

export type RegistryRestorePorts = Readonly<{
  registries: Pick<RegistryStore, "find" | "markRestored">;
  tables: Pick<RegistryTables, "restore">;
  audit: AppendAudit;
}>;

/** The registry as the copy holds it and its rows, read in pages from the copy. */
export type RegistryCopy = Readonly<{ registry: StoredRegistry; pages: Iterable<readonly StoredRow[]> }>;
export type RegistryRestoreInput = Readonly<{ copy: RegistryCopy; snapshotId: string; nowIso: string; requestId: string }>;
export type RegistryRestored = Readonly<{ registryId: string; schemaRevision: number; records: number }>;

const conflict = (field: string): DomainFault => new DomainFault({ code: "RESTORE_CONFLICT", fields: [field] });
const columnsOf = (registry: StoredRegistry): string => JSON.stringify(registry.columns);

export function restoreRegistry(ports: RegistryRestorePorts, input: RegistryRestoreInput): Commit<RegistryRestored> {
  const copied = input.copy.registry;
  if (copied.deletedAt !== null) throw conflict("snapshot");
  const current = ports.registries.find(copied.ownerId, copied.symbol);
  if (current === null || current.id !== copied.id) throw conflict("registry");
  if (current.deletedAt === null) throw conflict("deletedAt");
  if (current.schemaRevision !== copied.schemaRevision + 1) throw conflict("schemaRevision");
  if (current.tableName !== copied.tableName || columnsOf(current) !== columnsOf(copied)) throw conflict("columns");

  const records = ports.tables.restore(copied, input.copy.pages);
  ports.registries.markRestored(current, input.nowIso);
  ports.audit.append({
    ownerId: current.ownerId,
    action: "registry.restored",
    entityId: current.id,
    at: input.nowIso,
    requestId: input.requestId,
    details: { registry: current.symbol, records, columns: current.columns.length, snapshot: input.snapshotId },
  });
  return { value: { registryId: current.id, schemaRevision: current.schemaRevision + 1, records }, invalidations: [{ resource: "schema", ownerId: current.ownerId, resourceId: current.id }] };
}
