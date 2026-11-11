// The sessions of the owner (Scope §5.9; Architektura §9.6, §9.7; D43.1): the list, ending one other
// session, and ending all the others. The list and the end of one session need the access of the data;
// ending all the others is a sensitive action and needs a fresh second factor, which the policy decides
// and reads again inside the unit that deletes. The caller's own session is never ended here (signing
// out is its own operation), so an id that is not another live session of the owner is not found.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, type AccessOperation } from "../domain/access-policy.js";
import type { SessionFacts, SessionManagementPorts, SessionSummary } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";

export type SessionManagementDependencies = Readonly<{
  unit: UnitOfWork<SessionManagementPorts> & ReadUnit<SessionManagementPorts>;
  nowMs: () => number;
}>;

export type OwnerSession = SessionSummary & Readonly<{ current: boolean }>;

/** The caller's session after the policy allowed `operation`; the denial of the policy otherwise. */
function allowed(ports: SessionManagementPorts, token: string, nowMs: number, requestId: string, operation: AccessOperation): SessionFacts {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) {
    throw new DomainFault({ code: "AUTH_REQUIRED" });
  }
  const decision = decideAccess(access.snapshot, operation, nowMs);
  if (!decision.allow) {
    throw new DomainFault({ code: decision.code });
  }
  return access.session;
}

export function listOwnerSessions(deps: SessionManagementDependencies, token: string, requestId: string): Result<readonly OwnerSession[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly OwnerSession[]> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return { ok: false, error: { code: "AUTH_REQUIRED" } };
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      return { ok: false, error: { code: decision.code } };
    }
    const { ownerId, sessionId } = access.session;
    return { ok: true, value: ports.sessions.listActiveOfOwner(ownerId, nowMs).map((session) => ({ ...session, current: session.sessionId === sessionId })) };
  });
}

export function revokeOwnerSession(deps: SessionManagementDependencies, token: string, sessionId: string, requestId: string): Result<null> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const caller = allowed(ports, token, nowMs, requestId, "data");
    if (sessionId === caller.sessionId || !ports.sessions.deleteById(caller.ownerId, sessionId)) {
      throw new DomainFault({ code: "NOT_FOUND" });
    }
    ports.audit.append({ ownerId: caller.ownerId, action: "session.revoked", entityId: sessionId, at: new Date(nowMs).toISOString(), requestId, details: {} });
    return { value: null, invalidations: [] } satisfies Commit<null>;
  });
  return result.ok ? { ok: true, value: null } : result;
}

export function revokeOtherSessions(deps: SessionManagementDependencies, token: string, requestId: string): Result<Readonly<{ revoked: number }>> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const caller = allowed(ports, token, nowMs, requestId, "step_up");
    const revoked = ports.sessions.deleteAllButOne(caller.ownerId, caller.sessionId);
    ports.audit.append({ ownerId: caller.ownerId, action: "session.revoked_others", entityId: caller.ownerId, at: new Date(nowMs).toISOString(), requestId, details: { revoked } });
    return { value: { revoked }, invalidations: [] } satisfies Commit<{ revoked: number }>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
