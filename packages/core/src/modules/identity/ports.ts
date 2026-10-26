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
  /** The owner's e-mail, the label of the account in the authenticator app. */
  ownerEmail(): string | null;
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
  /** The trusted device that granted a `trusted` session; null for every other assurance. */
  trustedDeviceId: string | null;
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
  /** The enrollment in progress, bound to the session that began it. */
  pending: Readonly<{ challengeId: string; secret: string; expiresAtMs: number; sessionId: string }> | null;
  /** The current batch of recovery codes and the session that was shown them. */
  recoveryBatch: Readonly<{ batchId: string; sessionId: string }> | null;
}>;

/** The one store of the second factor's state (Architektura §9.6). */
export interface MfaStore {
  /** The state of a new owner: MFA required, enrollment not started. */
  initialize(ownerId: string): void;
  read(): MfaRecord | null;
  /**
   * Replaces the pending enrollment of a session; the active secret is untouched. Only while no
   * secret is active (`enrollment_state` required, generation `expectedGeneration`); false, with
   * nothing written, otherwise.
   */
  savePending(
    pending: Readonly<{ challengeId: string; secret: string; expiresAtMs: number; sessionId: string; expectedGeneration: number }>,
  ): boolean;
  /**
   * Compare-and-set of the replay ledger: records `step` as consumed for the active secret of
   * `expectedGeneration`, only if it is greater than the last consumed step. Of parallel requests
   * with the same step exactly one gets true; the others get false and must be refused.
   */
  consumeStep(change: Readonly<{ expectedGeneration: number; step: number }>): boolean;
  /**
   * Compare-and-set: moves the pending secret of `challengeId`, begun by `sessionId`, to active as
   * generation `expectedGeneration + 1`, records the consumed step and awaits the recovery
   * acknowledgment. False, with nothing written, if the challenge expired, belongs to another
   * session, or the challenge or the generation is no longer current.
   */
  activatePending(change: Readonly<{ challengeId: string; sessionId: string; expectedGeneration: number; usedStep: number; nowMs: number }>): boolean;
}

/** Recovery codes: only hashes are stored, in batches; one batch is current (Architektura §9.7). */
export interface RecoveryCodeStore {
  /**
   * Makes `batchId` the current batch for `sessionId`: the rows of every older batch are removed,
   * so an old code is gone, and the enrollment awaits the acknowledgment of this very batch.
   */
  issueBatch(batch: Readonly<{ batchId: string; sessionId: string; hashes: readonly string[] }>): void;
  /**
   * Compare-and-set: completes the enrollment if `batchId` is the current batch, shown to
   * `sessionId`, and the acknowledgment is still awaited. "batch_changed" if the batch is not the
   * current one (or another session was shown it), "not_awaited" if nothing is awaited.
   */
  acknowledge(request: Readonly<{ batchId: string; sessionId: string }>): "acknowledged" | "batch_changed" | "not_awaited";
  /**
   * Compare-and-set: marks the code with this hash as used, if it is in the current batch and
   * unused. Of parallel requests with one code exactly one gets the result, the others null.
   */
  consume(request: Readonly<{ hash: string; nowMs: number }>): Readonly<{ remaining: number }> | null;
}

/** Trusted devices (Architektura §9.3): a long-lived token whose hash is stored, expiring 30 days after creation. */
export interface TrustedDeviceStore {
  create(device: Readonly<{ deviceId: string; tokenHash: string; createdAtMs: number; expiresAtMs: number }>): void;
  /** The device of this token hash if it is not revoked and has not expired. Writes nothing. */
  findValid(tokenHash: string, nowMs: number): Readonly<{ deviceId: string }> | null;
  /** Revokes every device (password reset, MFA reset); returns how many were still valid. */
  revokeAll(nowMs: number): number;
}

/**
 * What enrolling a TOTP needs from the outside world: randomness, the secret box, the verifier
 * and the code generator. The server implements it with the secret box, the pinned OTP library
 * and Node's random source; core stays free of all three.
 */
export interface MfaCrypto {
  generateSecret(): string;
  /** The `otpauth://` URI for the authenticator app, and the key as the app shows it for typing. */
  describeSecret(secret: string, account: string): Readonly<{ otpauthUri: string; manualKey: string }>;
  seal(secret: string, context: Readonly<{ ownerId: string; generation: number }>): string;
  open(envelope: string, context: Readonly<{ ownerId: string; generation: number }>): string | null;
  /** The matching time step within the window, or null. */
  verify(secret: string, code: string, nowMs: number): Promise<number | null>;
  /** A fresh set of recovery codes: the plain codes to show once, and their hashes to store. */
  newRecoveryCodes(): Readonly<{ codes: readonly string[]; hashes: readonly string[] }>;
  /** The stored form of a typed recovery code in any accepted spelling; null if it cannot be one. */
  hashRecoveryCode(typed: string): string | null;
  /** A new device token, and the hash that is stored for it. */
  newTrustedDeviceToken(): string;
  hashTrustedDeviceToken(token: string): string;
}

/**
 * The one source of the current access decision's input (Architektura §18.7): the owner, the
 * session, the policy, the enrollment, the data choice and the trust, read from one consistent
 * state on the handle of the unit that also does the protected write. A mutation reads it again
 * inside its transaction; the actor of an earlier request proves nothing by itself.
 */
export interface IdentityAccessReader {
  current(actor: ActorContext): IdentityAccessSnapshot;
}

/** The ports of enrolling the second factor (Architektura §9.7, §18.7). */
export type EnrollmentPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive" | "rotate">;
  access: IdentityAccessReader;
  credentialReader: Pick<CredentialReader, "ownerEmail">;
  mfa: MfaStore;
  recovery: RecoveryCodeStore;
  audit: AppendAudit;
}>;

export type SignInPorts = Readonly<{
  attempts: AuthAttemptStore;
  /** Named apart from `credentials` of the owner ports, so one unit can hold both. */
  credentialReader: CredentialReader;
  sessions: SessionStore;
  owners: Pick<OwnerSingletonWriter, "hasOwner" | "currentAccessEpoch">;
  mfa: Pick<MfaStore, "read">;
  trusted: Pick<TrustedDeviceStore, "findValid">;
  access: IdentityAccessReader;
  audit: AppendAudit;
}>;

export type ResetPasswordPorts = Readonly<{
  owners: OwnerSingletonWriter;
  credentials: CredentialWriter;
  sessions: Pick<SessionStore, "deleteAllOfOwner">;
  trusted: Pick<TrustedDeviceStore, "revokeAll">;
  audit: AppendAudit;
}>;

/** The ports of proving the second factor: a TOTP or a recovery code at login, and the step-up. */
export type VerificationPorts = EnrollmentPorts & Readonly<{ trusted: Pick<TrustedDeviceStore, "create"> }>;
