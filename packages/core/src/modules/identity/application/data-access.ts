// Who may read the private data of the installation (Architektura §9.6, §9.7): the owner whose session passes
// the gate of the data (a signed-in session, the second factor in force or off, the recovery codes
// acknowledged, the starting data chosen). The answer names the session, for the routes that count work by
// session (the live stream) and for those that only need the gate (the diagnostics).
import type { ReadUnit, Result } from "../../../foundation/public.js";
import { decideAccess } from "../domain/access-policy.js";
import type { IdentityAccessReader, SessionStore } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";

export type DataAccessPorts = Readonly<{ sessions: Pick<SessionStore, "findActive">; access: IdentityAccessReader }>;
export type DataAccessDependencies = Readonly<{ unit: ReadUnit<DataAccessPorts>; nowMs: () => number }>;
export type DataAccessHolder = Readonly<{ sessionId: string }>;

/** The session of this token when it may read the data now; otherwise the code the gate refuses with. */
export function authorizeDataAccess(deps: DataAccessDependencies, token: string, requestId: string): Result<DataAccessHolder> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<DataAccessHolder> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
    const decision = decideAccess(access.snapshot, "data", nowMs);
    return decision.allow ? { ok: true, value: { sessionId: access.session.sessionId } } : { ok: false, error: { code: decision.code } };
  });
}
