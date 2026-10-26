// Resetting the owner's password (Architektura §9.6, §9.8; D09.4): the new credential, the raised
// access epoch, the end of every session and the audit entry commit together, so no session
// survives a changed password and no change is left without its trail. Trusted devices are
// revoked here as well once they exist (D11).
import { DomainFault, type Commit } from "../../../foundation/public.js";
import type { ResetPasswordPorts } from "../ports.js";

export type ResetPasswordCommand = Readonly<{
  /** PHC string of the shared PasswordHasher, computed before the unit of work. */
  passwordHash: string;
  requestId: string;
  /** ISO-8601 UTC. */
  now: string;
  /** The same instant in milliseconds, for the revocation time of the trusted devices. */
  nowMs: number;
}>;

export type PasswordReset = Readonly<{ accessEpoch: number; revokedSessions: number; revokedDevices: number }>;

/** Runs inside `UnitOfWork.run`; the ports are bound to its handle. */
export function resetOwnerPassword(ports: ResetPasswordPorts, command: ResetPasswordCommand): Commit<PasswordReset> {
  const ownerId = ports.owners.currentOwnerId();
  if (ownerId === null || !ports.credentials.replaceOwnerPassword({ ownerId, passwordHash: command.passwordHash, at: command.now })) {
    throw new DomainFault({ code: "OWNER_NOT_FOUND" });
  }
  const accessEpoch = ports.owners.advanceAccessEpoch();
  const revokedSessions = ports.sessions.deleteAllOfOwner(ownerId);
  // A trusted device is not a way around a password that was just replaced.
  const revokedDevices = ports.trusted.revokeAll(command.nowMs);
  ports.audit.append({
    ownerId,
    action: "owner.password_reset",
    entityId: ownerId,
    at: command.now,
    requestId: command.requestId,
    details: { accessEpoch, revokedSessions, revokedDevices },
  });
  return { value: { accessEpoch, revokedSessions, revokedDevices }, invalidations: [] };
}
