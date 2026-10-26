// Ports of the identity module for creating the owner (Architektura §9.8, §18.7). Their
// implementations are bound to the handle of one unit of work, so the owner, the credential and
// the audit entry commit or roll back together.
import type { AppendAudit } from "../audit/public.js";
import type { Assurance, EnrollmentState, IdentityAccessSnapshot, MfaPolicy } from "./domain/access-policy.js";
import type { LockoutBucket } from "./domain/lockout.js";
import type { ActorContext } from "../../foundation/public.js";

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
  /** The owner's id; null before an owner exists. */
  currentOwnerId(): string | null;
  /** The current access epoch; null before an owner exists. */
  currentAccessEpoch(): number | null;
  /** Raises the access epoch (password reset, MFA reset) and returns the new one. */
  advanceAccessEpoch(): number;
  /** Claims the singleton for an account written by `CredentialWriter` in the same unit. */
  claim(owner: Readonly<{ ownerId: string; at: string }>): void;
}

/** The login identity and password credential in the tables of the auth adapter. */
export interface CredentialWriter {
  insertOwnerAccount(account: NewOwnerAccount): void;
  /** Replaces the password hash of the owner's credential; false if the owner has none. */
  replaceOwnerPassword(change: Readonly<{ ownerId: string; passwordHash: string; at: string }>): boolean;
}

export type CreateOwnerPorts = Readonly<{
  owners: OwnerSingletonWriter;
  credentials: CredentialWriter;
  mfa: Pick<MfaStore, "initialize">;
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
  assurance: Assurance;
  passwordVerifiedAtMs: number;
  /** Set only by a verified TOTP (a recovery code or trust never produces it). */
  totpVerifiedAtMs: number | null;
  accessEpoch: number;
}>;

/** What the database says about a live session; the cookie only points to it. */
export type SessionFacts = Readonly<{
  sessionId: string;
  ownerId: string;
  assurance: Assurance;
  passwordVerifiedAtMs: number;
  totpVerifiedAtMs: number | null;
  accessEpoch: number;
}>;

export interface SessionStore {
  insert(session: NewSession): void;
  /** The authoritative read: the session of this token if it has not expired. Writes nothing. */
  findActive(token: string, nowMs: number): SessionFacts | null;
  /**
   * Promotion or step-up: ends the session of `oldToken` and inserts `next` in its place, so the
   * old token stops working at once. False, with nothing written, if the old session is gone.
   */
  rotate(oldToken: string, next: NewSession): boolean;
  /** True if a session was removed. */
  deleteByToken(token: string): boolean;
  /** Ends every session of the owner (password reset); returns how many existed. */
  deleteAllOfOwner(ownerId: string): number;
}

/** Encrypted values are opaque envelopes of the server's secret box; the port never sees a plain secret. */
export type MfaRecord = Readonly<{
  policy: MfaPolicy;
  enrollmentState: EnrollmentState;
  /** 0 until a TOTP secret is active; the envelope's authenticated context includes it. */
  secretGeneration: number;
  activeSecret: string | null;
  /** The last accepted TOTP time step: a step is usable once, only if greater. */
  lastUsedStep: number | null;
  pending: Readonly<{ challengeId: string; secret: string; expiresAtMs: number }> | null;
}>;

/** The one store of the second factor's state (Architektura §9.6). */
export interface MfaStore {
  /** The state of a new owner: MFA required, enrollment not started. */
  initialize(ownerId: string): void;
  read(): MfaRecord | null;
  /** Replaces the pending enrollment; the active secret is untouched. */
  savePending(pending: Readonly<{ challengeId: string; secret: string; expiresAtMs: number }>): void;
  /**
   * Compare-and-set: moves the pending secret of `challengeId` to active as generation
   * `expectedGeneration + 1`, records the consumed step and awaits the recovery acknowledgment.
   * False, with nothing written, if the challenge expired or the challenge or the generation is
   * no longer current.
   */
  activatePending(change: Readonly<{ challengeId: string; expectedGeneration: number; usedStep: number; nowMs: number }>): boolean;
}

export type SignInPorts = Readonly<{
  attempts: AuthAttemptStore;
  /** Named apart from `credentials` of the owner ports, so one unit can hold both. */
  credentialReader: CredentialReader;
  sessions: SessionStore;
  owners: Pick<OwnerSingletonWriter, "hasOwner" | "currentAccessEpoch">;
  access: IdentityAccessReader;
  audit: AppendAudit;
}>;

export type ResetPasswordPorts = Readonly<{
  owners: OwnerSingletonWriter;
  credentials: CredentialWriter;
  sessions: Pick<SessionStore, "deleteAllOfOwner">;
  audit: AppendAudit;
}>;

/**
 * The one source of the current access decision's input (Architektura §18.7): the owner, the
 * session, the policy, the enrollment, the data choice and the trust, read from one consistent
 * state on the handle of the unit that also does the protected write. A mutation reads it again
 * inside its transaction; the actor of an earlier request proves nothing by itself.
 */
export interface IdentityAccessReader {
  current(actor: ActorContext): IdentityAccessSnapshot;
}
