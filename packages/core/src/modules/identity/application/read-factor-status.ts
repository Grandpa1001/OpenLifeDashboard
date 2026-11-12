// What the Security page needs to know of the second factor (Scope §5.9; D43.7): whether it is in force, off or
// waiting for a new enrollment, and how many recovery codes are left. The page asks for a TOTP or for the password
// as the proof of a sensitive action by this: with the factor in force it is a TOTP, with the factor off a password.
// It is private data of the owner, so the access policy decides, and it writes nothing. No secret is in it.
import type { ReadUnit, Result } from "../../../foundation/public.js";
import { decideAccess, type MfaPolicy } from "../domain/access-policy.js";
import type { FactorStatusPorts } from "../ports.js";
import { resolveSessionAccess } from "./session-access.js";

export type FactorStatus = Readonly<{ policy: MfaPolicy; recoveryCodesRemaining: number }>;

export type FactorStatusDependencies = Readonly<{ unit: ReadUnit<FactorStatusPorts>; nowMs: () => number }>;

export function readFactorStatus(deps: FactorStatusDependencies, token: string, requestId: string): Result<FactorStatus> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<FactorStatus> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return { ok: false, error: { code: "AUTH_REQUIRED" } };
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      return { ok: false, error: { code: decision.code } };
    }
    const mfa = ports.mfa.read();
    return { ok: true, value: { policy: mfa?.policy ?? access.snapshot.mfaPolicy, recoveryCodesRemaining: mfa?.policy === "required" ? ports.recovery.remaining() : 0 } };
  });
}
