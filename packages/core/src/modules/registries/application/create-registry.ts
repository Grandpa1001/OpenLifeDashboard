// Creating and listing registries (Architektura §5.1, §18; D14.3). A registry is created in one
// unit of work: the access policy is read again inside it, the rules decide the definition against
// the catalog as it stands in that unit, and the catalog, the table and the audit entry commit or
// roll back together. The owner and the timestamps are the server's; the client sends a definition.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import type { AppendAudit } from "../../audit/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import { validateNewRegistry, type RegistryDraft, type RegistryIssue } from "../domain/definition.js";
import type { RegistryLimits } from "../domain/limits.js";
import type { RegistryStore, StoredRegistry } from "../ports.js";

export type RegistryPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  registries: RegistryStore;
  audit: AppendAudit;
}>;

export type RegistryDependencies = Readonly<{
  unit: UnitOfWork<RegistryPorts> & ReadUnit<RegistryPorts>;
  nowMs: () => number;
  /** A new identifier (UUIDv7) for the registry and for each of its columns. */
  newId: () => string;
  limits: RegistryLimits;
}>;

const toIssues = (issues: readonly RegistryIssue[]) => issues.map(({ path, code }) => ({ path, code }));

/**
 * A request that only repeats a taken symbol, or only hits the limit of registries, is a conflict
 * with the catalog, not a malformed form; anything else is a rejected request with all its issues.
 */
function refusal(issues: readonly RegistryIssue[]): DomainFault {
  if (issues.every((issue) => issue.path === "symbol" && issue.code === "SYMBOL_TAKEN")) {
    return new DomainFault({ code: "REGISTRY_SYMBOL_TAKEN", fields: ["symbol"] });
  }
  if (issues.every((issue) => issue.code === "LIMIT_REGISTRIES")) {
    return new DomainFault({ code: "REGISTRY_LIMIT_EXCEEDED" });
  }
  return new DomainFault({ code: "VALIDATION_FAILED", fields: [...new Set(issues.map((issue) => issue.path))], issues: toIssues(issues) });
}

export function createRegistry(deps: RegistryDependencies, token: string, draft: RegistryDraft, requestId: string): Result<StoredRegistry> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      throw new DomainFault({ code: "AUTH_REQUIRED" });
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      throw new DomainFault({ code: decision.code });
    }
    const ownerId = access.session.ownerId;
    const checked = validateNewRegistry(draft, {
      limits: deps.limits,
      takenRegistrySymbols: ports.registries.takenSymbols(ownerId),
      activeRegistryCount: ports.registries.activeCount(ownerId),
    });
    if (!checked.ok) {
      throw refusal(checked.issues);
    }
    const definition = checked.value;
    const registryId = deps.newId();
    const nowIso = new Date(nowMs).toISOString();
    ports.registries.insert({ id: registryId, ownerId, columnIds: definition.columns.map(() => deps.newId()), definition, nowIso });
    ports.audit.append({ ownerId, action: "registry.created", entityId: registryId, at: nowIso, requestId, details: { symbol: definition.symbol, columns: definition.columns.length } });
    const created = ports.registries.find(ownerId, definition.symbol);
    if (created === null) {
      throw new Error("the registry that was just created cannot be read");
    }
    return { value: created, invalidations: [] } satisfies Commit<StoredRegistry>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/** The registries of the owner that are not deleted, after the same gate as every private read. */
export function listRegistries(deps: Pick<RegistryDependencies, "unit" | "nowMs">, token: string, requestId: string): Result<readonly StoredRegistry[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly StoredRegistry[]> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return { ok: false, error: { code: "AUTH_REQUIRED" } };
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      return { ok: false, error: { code: decision.code } };
    }
    return { ok: true, value: ports.registries.list(access.session.ownerId) };
  });
}
