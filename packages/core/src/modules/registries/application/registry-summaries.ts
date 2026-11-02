// What the cards of the registries show (Scope §5.5, makieta 06; D32.2): how many records each active
// registry of the owner has and how many widgets are bound to it, read in one unit after the same gate
// as every private read. The list of registries itself stays as it is: only the cards ask for this.
import type { ReadUnit, Result } from "../../../foundation/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import type { DependentWidgets, RecordStore, RegistryStore, StoredRegistry } from "../ports.js";

export type RegistrySummaryPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  registries: Pick<RegistryStore, "list">;
  records: Pick<RecordStore, "count">;
  dependents: Pick<DependentWidgets, "countByRegistry">;
}>;

export type RegistrySummary = Readonly<{ registry: StoredRegistry; records: number; widgets: number }>;

export function listRegistrySummaries(deps: Readonly<{ unit: ReadUnit<RegistrySummaryPorts>; nowMs: () => number }>, token: string, requestId: string): Result<readonly RegistrySummary[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly RegistrySummary[]> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) return { ok: false, error: { code: decision.code } };
    const ownerId = access.session.ownerId;
    const widgets = ports.dependents.countByRegistry(ownerId);
    return { ok: true, value: ports.registries.list(ownerId).map((registry) => ({ registry, records: ports.records.count(registry), widgets: widgets.get(registry.id) ?? 0 })) };
  });
}
