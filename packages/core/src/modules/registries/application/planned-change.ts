// The first part of carrying out any change of the structure (Architektura §4.6, §5.2; D27.1, D28.1):
// in the unit of the writer, before any DDL, the registry as the writer reads it, the plan of the
// preview checked against it, and the change checked again against its columns. Each failure is a
// fault of the unit, so nothing is written.
import { DomainFault } from "../../../foundation/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import type { RegistryLimits } from "../domain/limits.js";
import { validateStructureChange, type StructureChange } from "../domain/structure-change.js";
import type { DictionaryLookup, PlanSigner, RegistryStore, StoredRegistry } from "../ports.js";
import { planFailure } from "./structure-preview.js";

export type PlannedChangeInput = Readonly<{ ownerId: string; symbol: string; change: unknown; planToken: string; requestId: string }>;

export function plannedChange(
  ports: Readonly<{ registries: Pick<RegistryStore, "find">; dictionaryLookup: Pick<DictionaryLookup, "ids"> }>,
  deps: Readonly<{ signer: PlanSigner; limits: RegistryLimits; nowMs: number }>,
  input: PlannedChangeInput,
): Readonly<{ registry: StoredRegistry; change: StructureChange }> {
  const registry = ports.registries.find(input.ownerId, input.symbol);
  if (registry === null || registry.deletedAt !== null) throw new DomainFault({ code: "NOT_FOUND" });
  const failure = planFailure(deps.signer, { planToken: input.planToken, ownerId: input.ownerId, change: input.change, registry }, deps.nowMs);
  if (failure !== null) throw new DomainFault(failure);
  const checked = validateStructureChange(input.change, { registryId: registry.id, columns: registry.columns }, { limits: deps.limits, dictionaryIds: ports.dictionaryLookup.ids(registry.ownerId) });
  if (!checked.ok) throw new DomainFault({ code: "VALIDATION_FAILED", fields: [...new Set(checked.issues.map((issue) => issue.path))], issues: checked.issues });
  return { registry, change: checked.value };
}

/** A kind of change this use case does not carry out: the request names another one. */
export const otherKind = (): DomainFault => new DomainFault({ code: "VALIDATION_FAILED", fields: ["kind"], issues: [{ path: "kind", code: "CHANGE_UNKNOWN" }] });

export type WriterAccessPorts = Readonly<{ sessions: Pick<SessionStore, "findActive">; access: IdentityAccessReader }>;

/**
 * The owner of a change of the structure, read again inside the unit of the writer: the session must
 * still pass the data access at the commit, whatever a read before the operation said (D13.2).
 */
export function writerOf(ports: WriterAccessPorts, token: string, nowMs: number, requestId: string): string {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) throw new DomainFault({ code: "AUTH_REQUIRED" });
  const decision = decideAccess(access.snapshot, "data", nowMs);
  if (!decision.allow) throw new DomainFault({ code: decision.code });
  return access.session.ownerId;
}
