// Ports of the identity module for creating the owner (Architektura §9.8, §18.7). Their
// implementations are bound to the handle of one unit of work, so the owner, the credential and
// the audit entry commit or roll back together.
import type { AppendAudit } from "../audit/public.js";

export type NewOwnerAccount = Readonly<{
  ownerId: string;
  /** Already normalized by the contract (trimmed, lower case). */
  email: string;
  /** PHC string of the shared PasswordHasher, computed before the unit of work. */
  passwordHash: string;
  /** ISO-8601 UTC. */
  at: string;
}>;

/** The owner singleton: at most one owner per installation, guarded by the database itself. */
export interface OwnerSingletonWriter {
  hasOwner(): boolean;
  /** Claims the singleton for an account written by `CredentialWriter` in the same unit. */
  claim(owner: Readonly<{ ownerId: string; at: string }>): void;
}

/** The login identity and password credential in the tables of the auth adapter. */
export interface CredentialWriter {
  insertOwnerAccount(account: NewOwnerAccount): void;
}

export type CreateOwnerPorts = Readonly<{
  owners: OwnerSingletonWriter;
  credentials: CredentialWriter;
  audit: AppendAudit;
}>;
