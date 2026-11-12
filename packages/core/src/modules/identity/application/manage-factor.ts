// Restarting and turning off the second factor from a live session (Scope §5.9; Architektura §9.6, §9.7;
// D43.5). Both are sensitive actions: the policy's `step_up` (a fresh TOTP, or a fresh password once the
// factor is off) is read again in the unit that writes.
//
// Restart ("set up again"): the secret, its replay ledger, the pending enrollment and the recovery codes are
// gone, the trusted devices are revoked and the other sessions end; the policy becomes `reset_required`, the
// same state `reset-mfa` leaves, so the next step is an enrollment, which the caller's own session can begin at
// once. It also turns the factor on again after it was turned off. The caller's session is replaced by one of
// the new epoch that has proved the password only: its TOTP no longer exists.
//
// Turn off: only an enrolled factor in force can be turned off, and only with the explicit acknowledgment of
// the request. The secret and the codes are gone, the devices are revoked, the other sessions end, the policy
// is `disabled`: the password is the factor and a step-up is a fresh password. Nothing but a restart turns it on.
import { DomainFault, type Commit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess } from "../domain/access-policy.js";
import type { FactorManagementPorts, SessionFacts } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";
import { renewedSession } from "./session-renewal.js";

export type FactorManagementDependencies = Readonly<{
  unit: UnitOfWork<FactorManagementPorts>;
  nowMs: () => number;
  newSessionId: () => string;
  newSessionToken: () => string;
}>;

/** What a restart commits: the session that replaces the caller's (its cookie is set after the commit) and what ended. */
export type FactorRestarted = Readonly<{ token: string; expiresAtMs: number; revokedSessions: number; revokedDevices: number }>;
export type FactorDisabled = Readonly<{ revokedSessions: number; revokedDevices: number }>;

function callerAllowed(ports: FactorManagementPorts, token: string, nowMs: number, requestId: string): SessionFacts {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) {
    throw new DomainFault({ code: "AUTH_REQUIRED" });
  }
  const decision = decideAccess(access.snapshot, "step_up", nowMs);
  if (!decision.allow) {
    throw new DomainFault({ code: decision.code });
  }
  return access.session;
}

export function restartSecondFactor(deps: FactorManagementDependencies, token: string, requestId: string): Result<FactorRestarted> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const caller = callerAllowed(ports, token, nowMs, requestId);
    ports.mfa.resetFactor();
    ports.recovery.discardAll();
    const accessEpoch = ports.owners.advanceAccessEpoch();
    const next = renewedSession(caller, { assurance: "password", passwordVerifiedAtMs: caller.passwordVerifiedAtMs, totpVerifiedAtMs: null, accessEpoch }, nowMs, {
      sessionId: deps.newSessionId(),
      token: deps.newSessionToken(),
    });
    if (!ports.sessions.rotate(token, next)) {
      throw new DomainFault({ code: "AUTH_REQUIRED" });
    }
    const revokedSessions = ports.sessions.deleteAllButOne(caller.ownerId, next.sessionId);
    const revokedDevices = ports.trusted.revokeAll(nowMs);
    ports.audit.append({ ownerId: caller.ownerId, action: "mfa.restarted", entityId: caller.ownerId, at: new Date(nowMs).toISOString(), requestId, details: { accessEpoch, revokedSessions, revokedDevices } });
    return { value: { token: next.token, expiresAtMs: next.expiresAtMs, revokedSessions, revokedDevices }, invalidations: [] } satisfies Commit<FactorRestarted>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

export function disableSecondFactor(deps: FactorManagementDependencies, token: string, requestId: string): Result<FactorDisabled> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const caller = callerAllowed(ports, token, nowMs, requestId);
    const mfa = ports.mfa.read();
    if (mfa === null || mfa.policy !== "required" || mfa.enrollmentState !== "complete") {
      throw new DomainFault({ code: "ENROLLMENT_CHANGED" });
    }
    ports.mfa.disableFactor();
    ports.recovery.discardAll();
    const revokedSessions = ports.sessions.deleteAllButOne(caller.ownerId, caller.sessionId);
    const revokedDevices = ports.trusted.revokeAll(nowMs);
    ports.audit.append({ ownerId: caller.ownerId, action: "mfa.disabled", entityId: caller.ownerId, at: new Date(nowMs).toISOString(), requestId, details: { revokedSessions, revokedDevices } });
    return { value: { revokedSessions, revokedDevices }, invalidations: [] } satisfies Commit<FactorDisabled>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
