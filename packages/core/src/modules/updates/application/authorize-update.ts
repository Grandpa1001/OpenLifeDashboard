// The authority to start an update (Architektura §11.2.2, §9.7; D54.4). The owner whose session passes the gate of the
// private data and has a fresh second factor (the policy's `step_up`) may start one; the access is read again inside the
// unit of work, and the start is recorded in the audit with the release and the operation and nothing else (`record` is
// false when the start is already known to be refused, so the trail holds only starts that were allowed to begin). Starting
// the work is not the use case's: it only says whether it may begin.
import { DomainFault, type Commit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import type { AppendAudit } from "../../audit/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";

export type UpdateAuthorizationPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  audit: AppendAudit;
}>;

export type UpdateAuthorizationDependencies = Readonly<{ unit: UnitOfWork<UpdateAuthorizationPorts>; nowMs: () => number }>;

export function authorizeUpdateStart(deps: UpdateAuthorizationDependencies, token: string, input: Readonly<{ release: string; operationId: string }>, requestId: string, record: boolean = true): Result<null> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<null> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) throw new DomainFault({ code: "AUTH_REQUIRED" });
    const decision = decideAccess(access.snapshot, "step_up", nowMs);
    if (!decision.allow) throw new DomainFault({ code: decision.code });
    if (record) ports.audit.append({ ownerId: access.session.ownerId, action: "update.started", entityId: input.operationId, at: new Date(nowMs).toISOString(), requestId, details: { release: input.release, operationId: input.operationId } });
    return { value: null, invalidations: [] };
  });
  return result.ok ? { ok: true, value: null } : result;
}
