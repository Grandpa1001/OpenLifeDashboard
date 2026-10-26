// Creating the owner (Architektura §9.8; D09.2): user + credential + owner singleton + audit
// entry in one unit of work. A second owner is refused before anything is written; whatever
// fails after that (the credential, the singleton, the audit) rolls the whole command back.
import { DomainFault, type Commit } from "../../../foundation/public.js";
import type { CreateOwnerPorts } from "../ports.js";

export type CreateOwnerCommand = Readonly<{
  ownerId: string;
  email: string;
  passwordHash: string;
  requestId: string;
  /** ISO-8601 UTC. */
  now: string;
}>;

export type OwnerCreated = Readonly<{ ownerId: string }>;

/** Runs inside `UnitOfWork.run`; the ports are bound to its handle. */
export function createOwner(ports: CreateOwnerPorts, command: CreateOwnerCommand): Commit<OwnerCreated> {
  if (ports.owners.hasOwner()) {
    throw new DomainFault({ code: "OWNER_ALREADY_EXISTS" });
  }
  ports.credentials.insertOwnerAccount({
    ownerId: command.ownerId,
    email: command.email,
    passwordHash: command.passwordHash,
    at: command.now,
  });
  ports.owners.claim({ ownerId: command.ownerId, at: command.now });
  ports.audit.append({
    ownerId: command.ownerId,
    action: "owner.created",
    entityId: command.ownerId,
    at: command.now,
    requestId: command.requestId,
  });
  return { value: { ownerId: command.ownerId }, invalidations: [] };
}
