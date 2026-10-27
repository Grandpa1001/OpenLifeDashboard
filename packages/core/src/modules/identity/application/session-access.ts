// The state around a session for the modules that decide something about it (Architektura §18.7):
// the live session of a token and the snapshot the access policy reads. Other modules (setup,
// settings) use this and `decideAccess`; they never read the session tables themselves.
import type { ActorContext } from "../../../foundation/public.js";
import type { IdentityAccessSnapshot } from "../domain/access-policy.js";
import type { IdentityAccessReader, SessionFacts, SessionStore } from "../ports.js";

export type SessionAccess = Readonly<{ session: SessionFacts; actor: ActorContext; snapshot: IdentityAccessSnapshot }>;

/** The session of this token with its current snapshot, or null if no live session of the owner exists. */
export function resolveSessionAccess(
  ports: Readonly<{ sessions: Pick<SessionStore, "findActive">; access: IdentityAccessReader }>,
  token: string,
  nowMs: number,
  requestId: string,
): SessionAccess | null {
  const session = ports.sessions.findActive(token, nowMs);
  if (session === null) {
    return null;
  }
  const actor: ActorContext = { ownerId: session.ownerId, sessionId: session.sessionId, requestId, accessEpoch: session.accessEpoch };
  const snapshot = ports.access.current(actor);
  return { session, actor, snapshot };
}
