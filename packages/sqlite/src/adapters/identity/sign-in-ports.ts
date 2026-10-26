// Sign-in ports on the handle of a unit of work (Architektura §9.8, §18.7): the failure buckets
// (`auth_lockout`), the owner's credential and the sessions in the tables of the auth adapter.
// Dates of the provider's tables are ISO-8601 UTC text (migration 2). The session reader is the
// authoritative one and writes nothing; it accepts only a session of the owner singleton.
import type { AuthAttemptStore, CredentialReader, NewSession, SessionFacts, SessionStore, SignInPorts } from "@openlife/core/identity";
import { LOCKOUT_WINDOW_MS } from "@openlife/core/identity";
import type { TransactionHandle } from "../../transactions/unit-of-work.js";

type BucketRow = Readonly<{ failures: number; window_started_at_ms: number; locked_until_ms: number | null }>;

const iso = (ms: number): string => new Date(ms).toISOString();

function bindAttempts(tx: TransactionHandle): AuthAttemptStore {
  const find = tx.prepare("SELECT failures, window_started_at_ms, locked_until_ms FROM auth_lockout WHERE bucket_key = ?");
  const save = tx.prepare(
    `INSERT INTO auth_lockout (bucket_key, failures, window_started_at_ms, locked_until_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT (bucket_key) DO UPDATE SET failures = excluded.failures, window_started_at_ms = excluded.window_started_at_ms, locked_until_ms = excluded.locked_until_ms`,
  );
  const clear = tx.prepare("DELETE FROM auth_lockout WHERE bucket_key = ?");
  const prune = tx.prepare("DELETE FROM auth_lockout WHERE (locked_until_ms IS NULL OR locked_until_ms <= ?) AND window_started_at_ms <= ?");
  return {
    find: (key) => {
      const row = find.get(key) as BucketRow | undefined;
      return row === undefined ? null : { failures: row.failures, windowStartedAtMs: row.window_started_at_ms, lockedUntilMs: row.locked_until_ms };
    },
    save: (key, bucket) => void save.run(key, bucket.failures, bucket.windowStartedAtMs, bucket.lockedUntilMs),
    clear: (key) => void clear.run(key),
    pruneExpired: (nowMs) => void prune.run(nowMs, nowMs - LOCKOUT_WINDOW_MS),
  };
}

function bindCredentials(tx: TransactionHandle): CredentialReader {
  const find = tx.prepare(
    `SELECT u.id AS ownerId, a.password AS passwordHash
       FROM instance_state s
       JOIN "user" u ON u.id = s.owner_id
       JOIN account a ON a.userId = u.id AND a.providerId = 'credential'
      WHERE u.email = ?`,
  );
  return {
    findOwnerByEmail: (email) => {
      const row = find.get(email) as { ownerId: string; passwordHash: string | null } | undefined;
      return row === undefined || row.passwordHash === null ? null : { ownerId: row.ownerId, passwordHash: row.passwordHash };
    },
  };
}

type FactsRow = Readonly<{
  sessionId: string;
  ownerId: string;
  assurance: SessionFacts["assurance"];
  passwordVerifiedAtMs: number;
  totpVerifiedAtMs: number | null;
  accessEpoch: number;
}>;

function bindSessions(tx: TransactionHandle): SessionStore {
  const insertSession = tx.prepare(
    `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertExt = tx.prepare(
    `INSERT INTO session_ext (session_id, assurance, password_verified_at_ms, totp_verified_at_ms, access_epoch) VALUES (?, ?, ?, ?, ?)`,
  );
  const active = tx.prepare(
    `SELECT s.id AS sessionId, s.userId AS ownerId, e.assurance AS assurance, e.password_verified_at_ms AS passwordVerifiedAtMs,
            e.totp_verified_at_ms AS totpVerifiedAtMs, e.access_epoch AS accessEpoch
       FROM session s
       JOIN instance_state o ON o.owner_id = s.userId
       JOIN session_ext e ON e.session_id = s.id
      WHERE s.token = ? AND s.expiresAt > ?`,
  );
  const remove = tx.prepare("DELETE FROM session WHERE token = ?");
  const removeAll = tx.prepare("DELETE FROM session WHERE userId = ?");
  const insert = (session: NewSession): void => {
    insertSession.run(
      session.sessionId,
      iso(session.expiresAtMs),
      session.token,
      iso(session.createdAtMs),
      iso(session.createdAtMs),
      session.ipAddress,
      session.userAgent,
      session.ownerId,
    );
    insertExt.run(session.sessionId, session.assurance, session.passwordVerifiedAtMs, session.totpVerifiedAtMs, session.accessEpoch);
  };
  return {
    insert,
    findActive: (token, nowMs) => (active.get(token, iso(nowMs)) as FactsRow | undefined) ?? null,
    rotate: (oldToken, next) => {
      // session_ext follows its session by ON DELETE CASCADE.
      if (remove.run(oldToken).changes === 0) {
        return false;
      }
      insert(next);
      return true;
    },
    deleteByToken: (token) => remove.run(token).changes > 0,
    deleteAllOfOwner: (ownerId) => removeAll.run(ownerId).changes,
  };
}

/** Everything of sign-in except the audit port and the owner singleton, which other adapters own. */
export function bindSignInStores(tx: TransactionHandle): Pick<SignInPorts, "attempts" | "credentialReader" | "sessions"> {
  return { attempts: bindAttempts(tx), credentialReader: bindCredentials(tx), sessions: bindSessions(tx) };
}
