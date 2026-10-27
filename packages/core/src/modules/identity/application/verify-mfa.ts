// Proving the second factor (Architektura §9.3, §9.7, §18.7; D11.2): a TOTP or a recovery code at
// login, and the TOTP of a step-up. Every proof ends the caller's session and starts a new one
// (promotion rotates the identifier), and the factor is consumed in the same unit of work: the
// time step through the replay ledger, a recovery code through its own compare-and-set. If the
// audit or anything else fails, the unit rolls back, the factor is not spent and no session
// exists; of parallel requests with one factor exactly one succeeds.
//
// What each proof is worth is separate: a TOTP gives `totp` assurance with a TOTP time (and may
// leave a trusted device); a recovery code gives `recovery` assurance, never a fresh TOTP and never
// trust; a step-up is a TOTP only, from a session that already has access to the data.
import type { Commit, Failure, ReadUnit, Result, UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, nextActionFor, type NextAction } from "../domain/access-policy.js";
import { TRUSTED_DEVICE_LIFETIME_MS } from "../domain/session-policy.js";
import type { MfaCrypto, VerificationPorts } from "../ports.js";
import { callerOf, commit, context, fail, failed, replacementSession, type Caller } from "./caller.js";
import { bucketKeysOf, lockedResult, recordRefusal, refuseWrongCode, type AttemptDependencies, type FactorOperation, type RequestContext } from "./factor-attempts.js";
import { clearAccountBucket, lockedFor } from "./lockout-buckets.js";

export type VerificationDependencies = AttemptDependencies &
  Readonly<{
    unit: UnitOfWork<VerificationPorts> & ReadUnit<VerificationPorts>;
    crypto: MfaCrypto;
    nowMs: () => number;
    newId: () => string;
    newSessionToken: () => string;
  }>;

/** The session that replaced the caller's, and what the browser must keep from this proof. */
export type MfaProof = Readonly<{
  token: string;
  expiresAtMs: number;
  nextAction: NextAction;
  /** Only after a recovery code: how many are left (the UI warns at two or fewer). */
  remainingRecoveryCodes: number | null;
  /** Only when the owner chose to remember the device; the plain token goes to the browser once. */
  trustedDevice: Readonly<{ token: string; expiresAtMs: number }> | null;
}>;

type Reading = Readonly<{ caller: Caller; secret: string }>;

/** What a unit that proves a factor commits: the proof, or a counted refusal (also a commit). */
type Outcome = Readonly<{ kind: "proved"; proof: MfaProof }> | Readonly<{ kind: "refused"; failure: Failure }>;

const settle = (result: Result<Commit<Outcome>>): Result<MfaProof> => {
  if (!result.ok) {
    return result;
  }
  const outcome = result.value.value;
  return outcome.kind === "proved" ? { ok: true, value: outcome.proof } : { ok: false, error: outcome.failure };
};

/** An enrolled owner under a required policy: the only state in which a factor is proven. */
function enrolledReading(deps: VerificationDependencies, caller: Caller): Result<Reading> {
  const { mfa } = caller;
  if (mfa.policy !== "required" || mfa.enrollmentState !== "complete" || mfa.activeSecret === null) {
    return failed("ENROLLMENT_CHANGED");
  }
  const secret = deps.crypto.open(mfa.activeSecret, context(caller, mfa.secretGeneration));
  return secret === null ? failed("ENROLLMENT_CHANGED") : { ok: true, value: { caller, secret } };
}

async function proveTotp(
  deps: VerificationDependencies,
  token: string,
  request: Readonly<{ code: string; rememberDevice: boolean }>,
  attempt: RequestContext,
  mode: "login" | "step_up",
): Promise<Result<MfaProof>> {
  const nowMs = deps.nowMs();
  const operation: FactorOperation = mode === "login" ? "verify" : "step_up";
  const first = deps.unit.read((ports): Result<Reading> => {
    const caller = callerOf(ports, token, nowMs, attempt.requestId);
    if (caller === null) {
      return failed("AUTH_REQUIRED");
    }
    // A blocked request is answered before anything about the code or the state is looked at.
    const locked = lockedFor(ports, bucketKeysOf(deps, caller.session.ownerId, attempt), nowMs);
    if (locked !== null) {
      return lockedResult(locked);
    }
    const reading = enrolledReading(deps, caller);
    if (!reading.ok || mode === "login") {
      return reading;
    }
    // A step-up confirms an action on data the session already reaches: the other states come first.
    const decision = decideAccess(caller.snapshot, "data", nowMs);
    return decision.allow ? reading : failed(decision.code);
  });
  if (!first.ok) {
    return first;
  }
  const { caller, secret } = first.value;
  const step = await deps.crypto.verify(secret, request.code, nowMs);
  if (step === null || step <= (caller.mfa.lastUsedStep ?? -1)) {
    return refuseWrongCode(deps, nowMs, { ownerId: caller.session.ownerId, operation, context: attempt });
  }

  const sessionId = deps.newId();
  const newToken = deps.newSessionToken();
  const deviceToken = request.rememberDevice ? deps.crypto.newTrustedDeviceToken() : null;
  const keys = bucketKeysOf(deps, caller.session.ownerId, attempt);
  const result = deps.unit.run((ports) => {
    const locked = lockedFor(ports, keys, nowMs);
    if (locked !== null) {
      return commit<Outcome>({ kind: "refused", failure: { code: "AUTH_LOCKED", retryAfterSeconds: locked } });
    }
    // The ledger decides: of two requests with the same step exactly one gets past this line,
    // the other is a counted refusal like any wrong code.
    if (!ports.mfa.consumeStep({ expectedGeneration: caller.mfa.secretGeneration, step })) {
      return commit<Outcome>({ kind: "refused", failure: recordRefusal(ports, keys, nowMs, { ownerId: caller.session.ownerId, operation, requestId: attempt.requestId }) });
    }
    const next = replacementSession(caller.session, { assurance: "totp", totpVerifiedAtMs: nowMs }, nowMs, { sessionId, token: newToken });
    if (!ports.sessions.rotate(token, next)) {
      return fail("AUTH_REQUIRED");
    }
    const deviceExpiresAtMs = nowMs + TRUSTED_DEVICE_LIFETIME_MS;
    if (deviceToken !== null) {
      ports.trusted.create({ deviceId: deps.newId(), tokenHash: deps.crypto.hashTrustedDeviceToken(deviceToken), createdAtMs: nowMs, expiresAtMs: deviceExpiresAtMs });
    }
    clearAccountBucket(ports, keys);
    ports.audit.append({
      ownerId: caller.session.ownerId,
      action: mode === "login" ? "mfa.verified" : "mfa.step_up",
      entityId: caller.session.ownerId,
      at: new Date(nowMs).toISOString(),
      requestId: attempt.requestId,
      details: { remembered: deviceToken !== null },
    });
    const snapshot = ports.access.current({ ownerId: next.ownerId, sessionId, requestId: attempt.requestId, accessEpoch: next.accessEpoch });
    return commit<Outcome>({
      kind: "proved",
      proof: {
        token: newToken,
        expiresAtMs: next.expiresAtMs,
        nextAction: nextActionFor(snapshot, nowMs),
        remainingRecoveryCodes: null,
        trustedDevice: deviceToken === null ? null : { token: deviceToken, expiresAtMs: deviceExpiresAtMs },
      },
    });
  });
  return settle(result);
}

/** A password session proves the TOTP; the owner may ask to remember the device. */
export function verifyTotp(
  deps: VerificationDependencies,
  token: string,
  request: Readonly<{ code: string; rememberDevice: boolean }>,
  context: RequestContext,
): Promise<Result<MfaProof>> {
  return proveTotp(deps, token, request, context, "login");
}

/** A fresh TOTP for a sensitive action: the session is rotated and its TOTP time renewed. */
export function stepUp(deps: VerificationDependencies, token: string, request: Readonly<{ code: string }>, context: RequestContext): Promise<Result<MfaProof>> {
  return proveTotp(deps, token, { ...request, rememberDevice: false }, context, "step_up");
}

/**
 * A recovery code in place of the TOTP. The session it produces opens the data but holds no TOTP
 * time, so it can never pass a step-up, and it creates no trust.
 */
export function verifyRecoveryCode(
  deps: VerificationDependencies,
  token: string,
  request: Readonly<{ recoveryCode: string }>,
  context: RequestContext,
): Result<MfaProof> {
  const nowMs = deps.nowMs();
  const hash = deps.crypto.hashRecoveryCode(request.recoveryCode);
  const sessionId = deps.newId();
  const newToken = deps.newSessionToken();
  const result = deps.unit.run((ports) => {
    const caller = callerOf(ports, token, nowMs, context.requestId);
    if (caller === null) {
      return fail("AUTH_REQUIRED");
    }
    const keys = bucketKeysOf(deps, caller.session.ownerId, context);
    const locked = lockedFor(ports, keys, nowMs);
    if (locked !== null) {
      return commit<Outcome>({ kind: "refused", failure: { code: "AUTH_LOCKED", retryAfterSeconds: locked } });
    }
    if (caller.mfa.policy !== "required" || caller.mfa.enrollmentState !== "complete") {
      return fail("ENROLLMENT_CHANGED");
    }
    // Of parallel requests with one code exactly one consumes it; a code that cannot exist is the same counted refusal.
    const used = hash === null ? null : ports.recovery.consume({ hash, nowMs });
    if (used === null) {
      return commit<Outcome>({ kind: "refused", failure: recordRefusal(ports, keys, nowMs, { ownerId: caller.session.ownerId, operation: "recovery_code", requestId: context.requestId }) });
    }
    const next = replacementSession(caller.session, { assurance: "recovery", totpVerifiedAtMs: null }, nowMs, { sessionId, token: newToken });
    if (!ports.sessions.rotate(token, next)) {
      return fail("AUTH_REQUIRED");
    }
    clearAccountBucket(ports, keys);
    ports.audit.append({
      ownerId: caller.session.ownerId,
      action: "mfa.recovery_used",
      entityId: caller.session.ownerId,
      at: new Date(nowMs).toISOString(),
      requestId: context.requestId,
      details: { remainingCodes: used.remaining },
    });
    const snapshot = ports.access.current({ ownerId: next.ownerId, sessionId, requestId: context.requestId, accessEpoch: next.accessEpoch });
    return commit<Outcome>({
      kind: "proved",
      proof: { token: newToken, expiresAtMs: next.expiresAtMs, nextAction: nextActionFor(snapshot, nowMs), remainingRecoveryCodes: used.remaining, trustedDevice: null },
    });
  });
  return settle(result);
}
