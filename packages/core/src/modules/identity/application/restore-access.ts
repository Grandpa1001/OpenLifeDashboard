// The access of a restored instance (Architektura §11.3.3 point 6; D50.2): after the database of a copy takes the
// place of the current one, every session and trusted device that copy knew is ended and the access epoch rises,
// so nothing a past token held is alive again; the password, the second factor and the owner's data stay. It is
// one unit of work with its audit entry: if any part fails, nothing changes.
import { DomainFault, type Commit } from "../../../foundation/public.js";
import type { RestoreAccessPorts } from "../ports.js";

export type RestoreAccessCommand = Readonly<{ requestId: string; now: string; nowMs: number; snapshotId: string }>;
export type AccessRevoked = Readonly<{ accessEpoch: number; revokedSessions: number; revokedDevices: number }>;

/** Runs inside `UnitOfWork.run`; the ports are bound to its handle. */
export function revokeAccessAfterRestore(ports: RestoreAccessPorts, command: RestoreAccessCommand): Commit<AccessRevoked> {
  const ownerId = ports.owners.currentOwnerId();
  if (ownerId === null) {
    throw new DomainFault({ code: "OWNER_NOT_FOUND" });
  }
  const accessEpoch = ports.owners.advanceAccessEpoch();
  const revokedSessions = ports.sessions.deleteAllOfOwner(ownerId);
  const revokedDevices = ports.trusted.revokeAll(command.nowMs);
  ports.audit.append({
    ownerId,
    action: "backup.restored",
    entityId: command.snapshotId,
    at: command.now,
    requestId: command.requestId,
    details: { accessEpoch, revokedSessions, revokedDevices },
  });
  return { value: { accessEpoch, revokedSessions, revokedDevices }, invalidations: [] };
}
