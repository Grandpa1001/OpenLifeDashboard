// Who may hold the live stream (Architektura §10, §9.6; D37): the owner whose session passes the same
// gate as the private data, read again whenever the stream asks. The answer names the session, which
// is the unit the number of streams is counted in.
import type { ReadUnit, Result } from "../../../foundation/public.js";
import { decideAccess } from "../domain/access-policy.js";
import type { IdentityAccessReader, SessionStore } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";

export type LiveStreamPorts = Readonly<{ sessions: Pick<SessionStore, "findActive">; access: IdentityAccessReader }>;
export type LiveStreamDependencies = Readonly<{ unit: ReadUnit<LiveStreamPorts>; nowMs: () => number }>;
export type LiveStreamHolder = Readonly<{ sessionId: string }>;

/** The session of this token when it may hold a stream now; otherwise the code the gate refuses with. */
export function authorizeLiveStream(deps: LiveStreamDependencies, token: string, requestId: string): Result<LiveStreamHolder> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<LiveStreamHolder> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
    const decision = decideAccess(access.snapshot, "data", nowMs);
    return decision.allow ? { ok: true, value: { sessionId: access.session.sessionId } } : { ok: false, error: { code: decision.code } };
  });
}
