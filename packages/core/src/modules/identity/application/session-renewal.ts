// The session that replaces the caller's after an action that changes what the caller has proven or the
// epoch it belongs to (a changed password, a restarted or disabled second factor, a confirmed password). The
// owner and the lifetime follow the rules of a new session; what the session has proven is stated by the
// caller of this function, never carried over by accident. The browser and the address stay with it: the
// store of sessions keeps them through a rotation.
import { SESSION_LIFETIME_MS } from "../domain/session-policy.js";
import type { Assurance } from "../domain/access-policy.js";
import type { NewSession, SessionFacts } from "../ports.js";

export type RenewedProof = Readonly<{
  assurance: Assurance;
  passwordVerifiedAtMs: number;
  totpVerifiedAtMs: number | null;
  accessEpoch: number;
}>;

export function renewedSession(old: SessionFacts, proof: RenewedProof, nowMs: number, ids: Readonly<{ sessionId: string; token: string }>): NewSession {
  return {
    sessionId: ids.sessionId,
    token: ids.token,
    ownerId: old.ownerId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + SESSION_LIFETIME_MS,
    ipAddress: null,
    userAgent: null,
    assurance: proof.assurance,
    passwordVerifiedAtMs: proof.passwordVerifiedAtMs,
    totpVerifiedAtMs: proof.totpVerifiedAtMs,
    accessEpoch: proof.accessEpoch,
    // A session renewed here stands on what it proved, never on a trusted device.
    trustedDeviceId: null,
  };
}
