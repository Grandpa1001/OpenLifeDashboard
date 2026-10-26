// Ports of the identity module for creating the owner (Architektura §9.8, §18.7). Their
// implementations are bound to the handle of one unit of work, so the owner, the credential and
// the audit entry commit or roll back together.
import type { AppendAudit } from "../audit/public.js";
import type { LockoutBucket } from "./domain/lockout.js";

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

// Ports of password sign-in, sign-out and status (Architektura §9.8, §18.7; D09.3). Like the
// owner ports they are bound to the handle of one unit of work.

/** Persistent failure buckets, keyed by an opaque hashed key (account or IP). */
export interface AuthAttemptStore {
  find(key: string): LockoutBucket | null;
  save(key: string, bucket: LockoutBucket): void;
  clear(key: string): void;
  /** Removes buckets that hold no information any more, so foreign logins cannot grow the table. */
  pruneExpired(nowMs: number): void;
}

export type OwnerCredential = Readonly<{ ownerId: string; passwordHash: string }>;

export interface CredentialReader {
  /** The owner's password credential when `email` (normalized) is the owner's; null otherwise. */
  findOwnerByEmail(email: string): OwnerCredential | null;
}

export type NewSession = Readonly<{
  sessionId: string;
  token: string;
  ownerId: string;
  createdAtMs: number;
  expiresAtMs: number;
  ipAddress: string | null;
  userAgent: string | null;
}>;

export interface SessionStore {
  insert(session: NewSession): void;
  /** The authoritative read: the session of this token if it has not expired. Writes nothing. */
  findActive(token: string, nowMs: number): Readonly<{ ownerId: string }> | null;
  /** True if a session was removed. */
  deleteByToken(token: string): boolean;
}

export type SignInPorts = Readonly<{
  attempts: AuthAttemptStore;
  credentials: CredentialReader;
  sessions: SessionStore;
  owners: Pick<OwnerSingletonWriter, "hasOwner">;
  audit: AppendAudit;
}>;
