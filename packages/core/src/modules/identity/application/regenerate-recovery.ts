// Regenerating the recovery codes of a complete enrollment (Scope §5.9; Architektura §9.6, §9.7; D43.4). It is
// a sensitive action: the policy's `step_up` (a TOTP proven in the last five minutes by this very session) is
// read again in the unit that writes. The new batch replaces the old one at once, so no old code works, is
// shown only in this answer, and is bound to the session that was shown it. The enrollment then awaits the
// acknowledgment of that batch, exactly as after the first enrollment: the owner acknowledges it, or, if the
// answer was lost, replaces it again with a TOTP (`reissueRecoveryCodes`). The codes are never stored in plain.
import { DomainFault, type Commit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, nextActionFor } from "../domain/access-policy.js";
import type { MfaCrypto, RegenerateRecoveryPorts } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";
import type { IssuedRecoveryCodes } from "./enroll-totp.js";

export type RegenerateRecoveryDependencies = Readonly<{
  unit: UnitOfWork<RegenerateRecoveryPorts>;
  crypto: Pick<MfaCrypto, "newRecoveryCodes">;
  nowMs: () => number;
  newId: () => string;
}>;

/** What the owner is shown once; the session keeps working with its own token. */
export type RegeneratedRecoveryCodes = Pick<IssuedRecoveryCodes, "batchId" | "recoveryCodes" | "nextAction">;

export function regenerateRecoveryCodes(deps: RegenerateRecoveryDependencies, token: string, requestId: string): Result<RegeneratedRecoveryCodes> {
  const nowMs = deps.nowMs();
  const batch = deps.crypto.newRecoveryCodes();
  const batchId = deps.newId();
  const result = deps.unit.run((ports) => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      throw new DomainFault({ code: "AUTH_REQUIRED" });
    }
    const decision = decideAccess(access.snapshot, "step_up", nowMs);
    if (!decision.allow) {
      throw new DomainFault({ code: decision.code });
    }
    // Codes exist only for a second factor that is enrolled and in force.
    const mfa = ports.mfa.read();
    if (mfa === null || mfa.policy !== "required" || mfa.enrollmentState !== "complete") {
      throw new DomainFault({ code: "ENROLLMENT_CHANGED" });
    }
    const { ownerId, sessionId, accessEpoch } = access.session;
    ports.recovery.issueBatch({ batchId, sessionId, hashes: batch.hashes });
    ports.audit.append({ ownerId, action: "mfa.recovery_regenerated", entityId: batchId, at: new Date(nowMs).toISOString(), requestId, details: {} });
    const snapshot = ports.access.current({ ownerId, sessionId, requestId, accessEpoch });
    return { value: { batchId, recoveryCodes: batch.codes, nextAction: nextActionFor(snapshot, nowMs) }, invalidations: [] } satisfies Commit<RegeneratedRecoveryCodes>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
