// Enrolling the second factor (Architektura §9.7, §18.7; D11.1): begin → confirm → acknowledge,
// and the reissue of the recovery codes after a lost view. The states are separate: confirming a
// TOTP activates the secret and promotes the session, but the data stay closed until the owner
// acknowledges the *current* batch of recovery codes from the session that was shown them.
//
// Checking a code is asynchronous, so every command reads and decides first, verifies outside a
// unit, and then does one unit of work that repeats the decisive checks as compare-and-set. A
// DomainFault inside the unit rolls it back whole; the plain recovery codes exist only in the
// returned outcome and are never stored.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, nextActionFor, type IdentityAccessSnapshot, type NextAction } from "../domain/access-policy.js";
import { SESSION_LIFETIME_MS } from "../domain/session-policy.js";
import type { EnrollmentCrypto, EnrollmentPorts, MfaRecord, NewSession, SessionFacts } from "../ports.js";

/** How long an enrollment challenge is valid (Architektura §9.7). */
export const ENROLLMENT_CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

export type EnrollmentDependencies = Readonly<{
  unit: UnitOfWork<EnrollmentPorts> & ReadUnit<EnrollmentPorts>;
  crypto: EnrollmentCrypto;
  nowMs: () => number;
  /** Challenge and batch identifiers. */
  newId: () => string;
  newSessionId: () => string;
  newSessionToken: () => string;
}>;

export type EnrollmentChallenge = Readonly<{ challengeId: string; otpauthUri: string; manualKey: string; expiresAtMs: number }>;

/** A new session of the promoted owner and the recovery codes shown once. */
export type IssuedRecoveryCodes = Readonly<{
  token: string;
  expiresAtMs: number;
  batchId: string;
  recoveryCodes: readonly string[];
  nextAction: NextAction;
}>;

export type EnrollmentStatus = Readonly<{ nextAction: NextAction }>;

const fail = (code: ConstructorParameters<typeof DomainFault>[0]["code"]): never => {
  throw new DomainFault({ code });
};
const failed = <T>(code: ConstructorParameters<typeof DomainFault>[0]["code"]): Result<T> => ({ ok: false, error: { code } });
const commit = <T>(value: T): Commit<T> => ({ value, invalidations: [] });

type Caller = Readonly<{ session: SessionFacts; snapshot: IdentityAccessSnapshot; mfa: MfaRecord; email: string }>;

/** The session of this token and the state around it, or why there is none. */
function callerOf(ports: EnrollmentPorts, token: string, nowMs: number, requestId: string): Caller | null {
  const session = ports.sessions.findActive(token, nowMs);
  const mfa = ports.mfa.read();
  const email = ports.credentialReader.ownerEmail();
  if (session === null || mfa === null || email === null) {
    return null;
  }
  const snapshot = ports.access.current({ ownerId: session.ownerId, sessionId: session.sessionId, requestId, accessEpoch: session.accessEpoch });
  const decision = decideAccess(snapshot, "data", nowMs);
  // Identity is what matters here; the other denials (factor, acknowledgment, data) are the states being resolved.
  return !decision.allow && decision.code === "AUTH_REQUIRED" ? null : { session, snapshot, mfa, email };
}

const context = (caller: Caller, generation: number) => ({ ownerId: caller.session.ownerId, generation });

/** The session that replaces the one that proved the factor: same owner and epoch, assurance totp. */
function promoted(old: SessionFacts, nowMs: number, sessionId: string, token: string): NewSession {
  return {
    sessionId,
    token,
    ownerId: old.ownerId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + SESSION_LIFETIME_MS,
    ipAddress: null,
    userAgent: null,
    assurance: "totp",
    passwordVerifiedAtMs: old.passwordVerifiedAtMs,
    totpVerifiedAtMs: nowMs,
    accessEpoch: old.accessEpoch,
  };
}

/**
 * Starts an enrollment, or returns the one already running for this session (no second secret).
 * Only while no secret is active: an enrolled owner is never reset through here.
 */
export async function beginEnrollment(deps: EnrollmentDependencies, token: string, requestId: string): Promise<Result<EnrollmentChallenge>> {
  const nowMs = deps.nowMs();
  const first = deps.unit.read((ports): Result<Readonly<{ caller: Caller; running: EnrollmentChallenge | null }>> => {
    const caller = callerOf(ports, token, nowMs, requestId);
    if (caller === null) {
      return failed("AUTH_REQUIRED");
    }
    if (caller.mfa.policy === "disabled" || caller.mfa.enrollmentState !== "required") {
      return failed("ENROLLMENT_CHANGED");
    }
    const pending = caller.mfa.pending;
    if (pending !== null && pending.sessionId === caller.session.sessionId && pending.expiresAtMs > nowMs) {
      const secret = deps.crypto.open(pending.secret, context(caller, caller.mfa.secretGeneration + 1));
      if (secret !== null) {
        return { ok: true, value: { caller, running: { challengeId: pending.challengeId, ...deps.crypto.describeSecret(secret, caller.email), expiresAtMs: pending.expiresAtMs } } };
      }
    }
    return { ok: true, value: { caller, running: null } };
  });
  if (!first.ok) {
    return first;
  }
  const { caller, running } = first.value;
  if (running !== null) {
    return { ok: true, value: running };
  }

  const secret = deps.crypto.generateSecret();
  const challengeId = deps.newId();
  const expiresAtMs = nowMs + ENROLLMENT_CHALLENGE_LIFETIME_MS;
  const sealed = deps.crypto.seal(secret, context(caller, caller.mfa.secretGeneration + 1));
  const saved = deps.unit.run((ports) => {
    const stored = ports.mfa.savePending({
      challengeId,
      secret: sealed,
      expiresAtMs,
      sessionId: caller.session.sessionId,
      expectedGeneration: caller.mfa.secretGeneration,
    });
    if (!stored) {
      return fail("ENROLLMENT_CHANGED");
    }
    ports.audit.append({ ownerId: caller.session.ownerId, action: "mfa.enrollment_started", entityId: caller.session.ownerId, at: new Date(nowMs).toISOString(), requestId });
    return commit(null);
  });
  return saved.ok ? { ok: true, value: { challengeId, ...deps.crypto.describeSecret(secret, caller.email), expiresAtMs } } : saved;
}

/** Confirms the pending secret with a code: activates it, promotes the session, issues the first batch. */
export async function confirmEnrollment(
  deps: EnrollmentDependencies,
  token: string,
  request: Readonly<{ challengeId: string; code: string }>,
  requestId: string,
): Promise<Result<IssuedRecoveryCodes>> {
  const nowMs = deps.nowMs();
  const first = deps.unit.read((ports): Result<Readonly<{ caller: Caller; secret: string }>> => {
    const caller = callerOf(ports, token, nowMs, requestId);
    if (caller === null) {
      return failed("AUTH_REQUIRED");
    }
    const pending = caller.mfa.pending;
    // A foreign, expired or replaced challenge is one answer: the enrollment is not what the caller thinks.
    if (
      caller.mfa.enrollmentState !== "required" ||
      pending === null ||
      pending.challengeId !== request.challengeId ||
      pending.sessionId !== caller.session.sessionId ||
      pending.expiresAtMs <= nowMs
    ) {
      return failed("ENROLLMENT_CHANGED");
    }
    const secret = deps.crypto.open(pending.secret, context(caller, caller.mfa.secretGeneration + 1));
    return secret === null ? failed("ENROLLMENT_CHANGED") : { ok: true, value: { caller, secret } };
  });
  if (!first.ok) {
    return first;
  }
  const { caller, secret } = first.value;
  const step = await deps.crypto.verify(secret, request.code, nowMs);
  if (step === null || step <= (caller.mfa.lastUsedStep ?? -1)) {
    return failed("MFA_INVALID_CODE");
  }

  const batch = deps.crypto.newRecoveryCodes();
  const batchId = deps.newId();
  const sessionId = deps.newSessionId();
  const newToken = deps.newSessionToken();
  const result = deps.unit.run((ports) => {
    const activated = ports.mfa.activatePending({
      challengeId: request.challengeId,
      sessionId: caller.session.sessionId,
      expectedGeneration: caller.mfa.secretGeneration,
      usedStep: step,
      nowMs,
    });
    if (!activated) {
      return fail("ENROLLMENT_CHANGED");
    }
    const next = promoted(caller.session, nowMs, sessionId, newToken);
    if (!ports.sessions.rotate(token, next)) {
      return fail("AUTH_REQUIRED");
    }
    ports.recovery.issueBatch({ batchId, sessionId, hashes: batch.hashes });
    ports.audit.append({ ownerId: caller.session.ownerId, action: "mfa.enrolled", entityId: caller.session.ownerId, at: new Date(nowMs).toISOString(), requestId });
    const snapshot = ports.access.current({ ownerId: next.ownerId, sessionId, requestId, accessEpoch: next.accessEpoch });
    return commit<IssuedRecoveryCodes>({ token: newToken, expiresAtMs: next.expiresAtMs, batchId, recoveryCodes: batch.codes, nextAction: nextActionFor(snapshot, nowMs) });
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/**
 * A lost view of the codes: a fresh TOTP (a step not used before) replaces the batch, binds it to
 * the session that is shown the new codes and invalidates the old ones. Only while the first
 * acknowledgment is pending; regenerating codes of a complete enrollment is a step-up action of the
 * security settings (D43).
 */
export async function reissueRecoveryCodes(
  deps: EnrollmentDependencies,
  token: string,
  request: Readonly<{ code: string }>,
  requestId: string,
): Promise<Result<IssuedRecoveryCodes>> {
  const nowMs = deps.nowMs();
  const first = deps.unit.read((ports): Result<Readonly<{ caller: Caller; secret: string }>> => {
    const caller = callerOf(ports, token, nowMs, requestId);
    if (caller === null) {
      return failed("AUTH_REQUIRED");
    }
    if (caller.mfa.enrollmentState !== "awaiting_recovery_ack" || caller.mfa.activeSecret === null) {
      return failed("ENROLLMENT_CHANGED");
    }
    const secret = deps.crypto.open(caller.mfa.activeSecret, context(caller, caller.mfa.secretGeneration));
    return secret === null ? failed("ENROLLMENT_CHANGED") : { ok: true, value: { caller, secret } };
  });
  if (!first.ok) {
    return first;
  }
  const { caller, secret } = first.value;
  const step = await deps.crypto.verify(secret, request.code, nowMs);
  if (step === null || step <= (caller.mfa.lastUsedStep ?? -1)) {
    return failed("MFA_INVALID_CODE");
  }

  const batch = deps.crypto.newRecoveryCodes();
  const batchId = deps.newId();
  const sessionId = deps.newSessionId();
  const newToken = deps.newSessionToken();
  const result = deps.unit.run((ports) => {
    // The ledger decides: of two requests with the same step exactly one gets here.
    if (!ports.mfa.consumeStep({ expectedGeneration: caller.mfa.secretGeneration, step })) {
      return fail("MFA_INVALID_CODE");
    }
    const next = promoted(caller.session, nowMs, sessionId, newToken);
    if (!ports.sessions.rotate(token, next)) {
      return fail("AUTH_REQUIRED");
    }
    ports.recovery.issueBatch({ batchId, sessionId, hashes: batch.hashes });
    ports.audit.append({ ownerId: caller.session.ownerId, action: "mfa.recovery_reissued", entityId: caller.session.ownerId, at: new Date(nowMs).toISOString(), requestId });
    const snapshot = ports.access.current({ ownerId: next.ownerId, sessionId, requestId, accessEpoch: next.accessEpoch });
    return commit<IssuedRecoveryCodes>({ token: newToken, expiresAtMs: next.expiresAtMs, batchId, recoveryCodes: batch.codes, nextAction: nextActionFor(snapshot, nowMs) });
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/** Acknowledges the *current* batch from the session that was shown it; repeating it is harmless. */
export function acknowledgeRecovery(
  deps: EnrollmentDependencies,
  token: string,
  request: Readonly<{ batchId: string }>,
  requestId: string,
): Result<EnrollmentStatus> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const caller = callerOf(ports, token, nowMs, requestId);
    if (caller === null) {
      return fail("AUTH_REQUIRED");
    }
    const sessionId = caller.session.sessionId;
    const batch = caller.mfa.recoveryBatch;
    if (caller.mfa.enrollmentState === "complete" && batch?.batchId === request.batchId && batch.sessionId === sessionId) {
      return commit<EnrollmentStatus>({ nextAction: nextActionFor(caller.snapshot, nowMs) });
    }
    const outcome = ports.recovery.acknowledge({ batchId: request.batchId, sessionId });
    if (outcome === "batch_changed") {
      return fail("RECOVERY_BATCH_CHANGED");
    }
    if (outcome === "not_awaited") {
      return fail("ENROLLMENT_CHANGED");
    }
    ports.audit.append({ ownerId: caller.session.ownerId, action: "mfa.recovery_acknowledged", entityId: request.batchId, at: new Date(nowMs).toISOString(), requestId });
    const snapshot = ports.access.current({ ownerId: caller.session.ownerId, sessionId, requestId, accessEpoch: caller.session.accessEpoch });
    return commit<EnrollmentStatus>({ nextAction: nextActionFor(snapshot, nowMs) });
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
