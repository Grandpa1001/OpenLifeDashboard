// IdentityAccessReader on the handle of a unit of work (Architektura §9.7, §18.7; D10.2): one
// consistent read of everything the access policy needs, mapped to its snapshot. Nothing here
// decides; a row that cannot be found becomes the state that denies. A `trusted` session stands
// on its device: revoked, expired or missing trust is read as such and the policy refuses it.
import type { IdentityAccessReader, IdentityAccessSnapshot } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type Row = Readonly<{
  ownerId: string | null;
  epoch: number | null;
  dataChoice: IdentityAccessSnapshot["dataChoice"] | null;
  sessionOwner: string | null;
  sessionExpiresAt: string | null;
  assurance: IdentityAccessSnapshot["assurance"] | null;
  sessionEpoch: number | null;
  passwordVerifiedAtMs: number | null;
  totpVerifiedAtMs: number | null;
  policy: IdentityAccessSnapshot["mfaPolicy"] | null;
  enrollmentState: IdentityAccessSnapshot["enrollmentState"] | null;
  trustFound: number | null;
  trustExpiresAtMs: number | null;
  trustRevokedAtMs: number | null;
}>;

/** The trust a `trusted` session stands on; a device that cannot be found is no trust. */
function trustedStateOf(row: Row, nowMs: number): IdentityAccessSnapshot["trustedState"] {
  if (row.assurance !== "trusted") {
    return "not_used";
  }
  if (!row.trustFound || row.trustRevokedAtMs !== null) {
    return "revoked";
  }
  return row.trustExpiresAtMs !== null && row.trustExpiresAtMs <= nowMs ? "expired" : "valid";
}

/** `nowMs` is the injected clock: expiry is judged by it, not by the database's. */
export function bindIdentityAccessReader(tx: TransactionHandle, nowMs: () => number): IdentityAccessReader {
  const read = tx.prepare(
    `SELECT (SELECT owner_id FROM instance_state) AS ownerId,
            (SELECT access_epoch FROM instance_state) AS epoch,
            (SELECT data_choice FROM instance_state) AS dataChoice,
            s.userId AS sessionOwner, s.expiresAt AS sessionExpiresAt,
            e.assurance AS assurance, e.access_epoch AS sessionEpoch,
            e.password_verified_at_ms AS passwordVerifiedAtMs, e.totp_verified_at_ms AS totpVerifiedAtMs,
            (SELECT policy FROM mfa_state) AS policy,
            (SELECT enrollment_state FROM mfa_state) AS enrollmentState,
            d.id IS NOT NULL AS trustFound, d.expires_at_ms AS trustExpiresAtMs, d.revoked_at_ms AS trustRevokedAtMs
       FROM (SELECT 1) AS one
       LEFT JOIN "session" s ON s.id = ?
       LEFT JOIN session_ext e ON e.session_id = s.id
       LEFT JOIN trusted_device d ON d.id = e.trusted_device_id`,
  );
  return {
    current: (actor) => {
      const row = read.get(actor.sessionId) as Row;
      const ownerExists = row.ownerId !== null;
      const sessionFound = row.sessionOwner !== null && row.assurance !== null;
      const expired = row.sessionExpiresAt !== null && row.sessionExpiresAt <= new Date(nowMs()).toISOString();
      return {
        ownerExists,
        ownerMatches: ownerExists && row.ownerId === actor.ownerId && row.sessionOwner === row.ownerId,
        // A vanished row is a revoked session: logout, reset and rotation all remove it.
        sessionState: !sessionFound ? "revoked" : expired ? "expired" : "active",
        epochMatches: row.epoch !== null && row.sessionEpoch === row.epoch && actor.accessEpoch === row.epoch,
        // Without a state row the owner has no valid factor: the strictest reading.
        mfaPolicy: row.policy ?? "reset_required",
        enrollmentState: row.enrollmentState ?? "required",
        assurance: row.assurance ?? "password",
        trustedState: trustedStateOf(row, nowMs()),
        dataChoice: row.dataChoice ?? "unselected",
        totpVerifiedAtMs: row.totpVerifiedAtMs,
        passwordVerifiedAtMs: row.passwordVerifiedAtMs,
      };
    },
  };
}
