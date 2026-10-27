// The administrative `reset-mfa` (Architektura §9.6; D11.4): the second factor is removed and a
// new enrollment is required, every session ends, every trusted device is revoked and the access
// epoch rises; the password stays, and so do the owner's data and the choice of the starting data.
// It is one unit of work with its audit entry: if any part fails, nothing changes.
import { DomainFault, type Commit } from "../../../foundation/public.js";
import type { ResetMfaPorts } from "../ports.js";

export type ResetMfaCommand = Readonly<{ requestId: string; now: string; nowMs: number }>;
export type MfaReset = Readonly<{ accessEpoch: number; revokedSessions: number; revokedDevices: number }>;

/** Runs inside `UnitOfWork.run`; the ports are bound to its handle. */
export function resetOwnerMfa(ports: ResetMfaPorts, command: ResetMfaCommand): Commit<MfaReset> {
  const ownerId = ports.owners.currentOwnerId();
  if (ownerId === null) {
    throw new DomainFault({ code: "OWNER_NOT_FOUND" });
  }
  ports.mfa.resetFactor();
  ports.recovery.discardAll();
  const accessEpoch = ports.owners.advanceAccessEpoch();
  const revokedSessions = ports.sessions.deleteAllOfOwner(ownerId);
  const revokedDevices = ports.trusted.revokeAll(command.nowMs);
  ports.audit.append({
    ownerId,
    action: "owner.mfa_reset",
    entityId: ownerId,
    at: command.now,
    requestId: command.requestId,
    details: { accessEpoch, revokedSessions, revokedDevices },
  });
  return { value: { accessEpoch, revokedSessions, revokedDevices }, invalidations: [] };
}
