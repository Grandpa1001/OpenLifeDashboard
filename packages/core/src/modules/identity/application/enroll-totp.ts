// Enrolling the second factor (Architektura §9.7, §18.7; D11.1): begin → confirm → acknowledge,
// and the reissue of the recovery codes after a lost view. The states are separate: confirming a
// TOTP activates the secret and promotes the session, but the data stay closed until the owner
// acknowledges the *current* batch of recovery codes from the session that was shown them.
//
// Checking a code is asynchronous, so every command reads and decides first, verifies outside a
// unit, and then does one unit of work that repeats the decisive checks as compare-and-set. A
// DomainFault inside the unit rolls it back whole; the plain recovery codes exist only in the
// returned outcome and are never stored.
import type { Commit, Failure, ReadUnit, Result, UnitOfWork } from "../../../foundation/public.js";
import { nextActionFor, type NextAction } from "../domain/access-policy.js";
import type { EnrollmentPorts, MfaCrypto } from "../ports.js";
import { callerOf, commit, context, fail, failed, replacementSession, type Caller } from "./caller.js";
import { bucketKeysOf, lockedResult, recordRefusal, refuseWrongCode, type AttemptDependencies, type FactorOperation, type RequestContext } from "./factor-attempts.js";
import { clearAccountBucket, lockedFor } from "./lockout-buckets.js";

/** How long an enrollment challenge is valid (Architektura §9.7). */
export const ENROLLMENT_CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

export type EnrollmentDependencies = AttemptDependencies &
  Readonly<{
    unit: UnitOfWork<EnrollmentPorts> & ReadUnit<EnrollmentPorts>;
    crypto: MfaCrypto;
    nowMs: () => number;
    /** Challenge and batch identifiers. */
    newId: () => string;
    newSessionId: () => string;
    newSessionToken: () => string;
  }>;

/** What a unit that issues codes commits: the issue, or a counted refusal (also a commit). */
type Outcome = Readonly<{ kind: "issued"; issued: IssuedRecoveryCodes }> | Readonly<{ kind: "refused"; failure: Failure }>;

const settle = (result: Result<Commit<Outcome>>): Result<IssuedRecoveryCodes> => {
  if (!result.ok) {
    return result;
  }
  const outcome = result.value.value;
  return outcome.kind === "issued" ? { ok: true, value: outcome.issued } : { ok: false, error: outcome.failure };
};

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
  attempt: RequestContext,
): Promise<Result<IssuedRecoveryCodes>> {
  const nowMs = deps.nowMs();
  const requestId = attempt.requestId;
  const first = deps.unit.read((ports): Result<Readonly<{ caller: Caller; secret: string }>> => {
    const caller = callerOf(ports, token, nowMs, requestId);
    if (caller === null) {
      return failed("AUTH_REQUIRED");
    }
    const locked = lockedFor(ports, bucketKeysOf(deps, caller.session.ownerId, attempt), nowMs);
    if (locked !== null) {
      return lockedResult(locked);
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
    return refuseWrongCode(deps, nowMs, { ownerId: caller.session.ownerId, operation: "enrollment_confirm", context: attempt });
  }

  const batch = deps.crypto.newRecoveryCodes();
  const batchId = deps.newId();
  const sessionId = deps.newSessionId();
  const newToken = deps.newSessionToken();
  const keys = bucketKeysOf(deps, caller.session.ownerId, attempt);
  const result = deps.unit.run((ports) => {
    const locked = lockedFor(ports, keys, nowMs);
    if (locked !== null) {
      return commit<Outcome>({ kind: "refused", failure: { code: "AUTH_LOCKED", retryAfterSeconds: locked } });
    }
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
    const next = replacementSession(caller.session, { assurance: "totp", totpVerifiedAtMs: nowMs }, nowMs, { sessionId, token: newToken });
    if (!ports.sessions.rotate(token, next)) {
      return fail("AUTH_REQUIRED");
    }
    ports.recovery.issueBatch({ batchId, sessionId, hashes: batch.hashes });
    clearAccountBucket(ports, keys);
    ports.audit.append({ ownerId: caller.session.ownerId, action: "mfa.enrolled", entityId: caller.session.ownerId, at: new Date(nowMs).toISOString(), requestId });
    const snapshot = ports.access.current({ ownerId: next.ownerId, sessionId, requestId, accessEpoch: next.accessEpoch });
    return commit<Outcome>({ kind: "issued", issued: { token: newToken, expiresAtMs: next.expiresAtMs, batchId, recoveryCodes: batch.codes, nextAction: nextActionFor(snapshot, nowMs) } });
  });
  return settle(result);
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
  attempt: RequestContext,
): Promise<Result<IssuedRecoveryCodes>> {
  const nowMs = deps.nowMs();
  const requestId = attempt.requestId;
  const first = deps.unit.read((ports): Result<Readonly<{ caller: Caller; secret: string }>> => {
    const caller = callerOf(ports, token, nowMs, requestId);
    if (caller === null) {
      return failed("AUTH_REQUIRED");
    }
    const locked = lockedFor(ports, bucketKeysOf(deps, caller.session.ownerId, attempt), nowMs);
    if (locked !== null) {
      return lockedResult(locked);
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
    return refuseWrongCode(deps, nowMs, { ownerId: caller.session.ownerId, operation: "recovery_reissue", context: attempt });
  }

  const batch = deps.crypto.newRecoveryCodes();
  const batchId = deps.newId();
  const sessionId = deps.newSessionId();
  const newToken = deps.newSessionToken();
  const keys = bucketKeysOf(deps, caller.session.ownerId, attempt);
  const operation: FactorOperation = "recovery_reissue";
  const result = deps.unit.run((ports) => {
    const locked = lockedFor(ports, keys, nowMs);
    if (locked !== null) {
      return commit<Outcome>({ kind: "refused", failure: { code: "AUTH_LOCKED", retryAfterSeconds: locked } });
    }
    // The ledger decides: of two requests with the same step exactly one gets here, the other is a counted refusal.
    if (!ports.mfa.consumeStep({ expectedGeneration: caller.mfa.secretGeneration, step })) {
      return commit<Outcome>({ kind: "refused", failure: recordRefusal(ports, keys, nowMs, { ownerId: caller.session.ownerId, operation, requestId }) });
    }
    const next = replacementSession(caller.session, { assurance: "totp", totpVerifiedAtMs: nowMs }, nowMs, { sessionId, token: newToken });
    if (!ports.sessions.rotate(token, next)) {
      return fail("AUTH_REQUIRED");
    }
    ports.recovery.issueBatch({ batchId, sessionId, hashes: batch.hashes });
    clearAccountBucket(ports, keys);
    ports.audit.append({ ownerId: caller.session.ownerId, action: "mfa.recovery_reissued", entityId: caller.session.ownerId, at: new Date(nowMs).toISOString(), requestId });
    const snapshot = ports.access.current({ ownerId: next.ownerId, sessionId, requestId, accessEpoch: next.accessEpoch });
    return commit<Outcome>({ kind: "issued", issued: { token: newToken, expiresAtMs: next.expiresAtMs, batchId, recoveryCodes: batch.codes, nextAction: nextActionFor(snapshot, nowMs) } });
  });
  return settle(result);
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
